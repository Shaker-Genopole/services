// Thin wrapper around @mysten/sui (gRPC transport) for the zk_sla package.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';

export interface SuiSlaConfig {
  network: string;
  grpcUrl: string;
  packageId: string;
  registryId: string;
  /** bech32 `suiprivkey…`; required only for writes. */
  privateKey?: string;
}

export interface ExecutionReceipt {
  digest: string;
  success: boolean;
  error?: string;
  /** computation + storage - rebate, in MIST. */
  gasUsedMist: number;
}

export interface ChainEvent {
  type: string;
  module: string;
  sender: string;
  json: Record<string, unknown> | null;
  digest: string;
  eventIndex: number;
  checkpoint: string;
}

const hexBytes = (hex: string) => Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));

export class SuiSlaClient {
  readonly client: SuiGrpcClient;
  private readonly signer?: Ed25519Keypair;

  constructor(private readonly cfg: SuiSlaConfig) {
    this.client = new SuiGrpcClient({ network: cfg.network, baseUrl: cfg.grpcUrl });
    if (cfg.privateKey) this.signer = Ed25519Keypair.fromSecretKey(cfg.privateKey);
  }

  static fromEnv(env: {
    SUI_NETWORK: string;
    SUI_GRPC_URL: string;
    SUI_PACKAGE_ID?: string;
    SUI_VERIFIER_REGISTRY_ID?: string;
    SUI_PRIVATE_KEY?: string;
  }): SuiSlaClient | null {
    if (!env.SUI_PACKAGE_ID || !env.SUI_VERIFIER_REGISTRY_ID) return null;
    return new SuiSlaClient({
      network: env.SUI_NETWORK,
      grpcUrl: env.SUI_GRPC_URL,
      packageId: env.SUI_PACKAGE_ID,
      registryId: env.SUI_VERIFIER_REGISTRY_ID,
      privateKey: env.SUI_PRIVATE_KEY,
    });
  }

  get canWrite() {
    return Boolean(this.signer);
  }

  get address() {
    return this.signer?.toSuiAddress();
  }

  /** `zk_sla::sla::submit_proof`, transferring the period reward back to the provider. */
  async submitSlaProof(p: {
    agreementId: string;
    period: number;
    metricsCommitment: string;
    proofHex: string;
  }) {
    const tx = new Transaction();
    const reward = tx.moveCall({
      target: `${this.cfg.packageId}::sla::submit_proof`,
      arguments: [
        tx.object(p.agreementId),
        tx.object(this.cfg.registryId),
        tx.pure.u64(p.period),
        tx.pure.u256(BigInt(p.metricsCommitment)),
        tx.pure.vector('u8', hexBytes(p.proofHex)),
        tx.object.clock(),
      ],
    });
    tx.transferObjects([reward], this.requireSigner().toSuiAddress());
    return this.execute(tx);
  }

  /** `zk_sla::negotiation::prove_offer`. */
  async proveOffer(p: { requestId: string; offerId: string; proofHex: string }) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.cfg.packageId}::negotiation::prove_offer`,
      arguments: [
        tx.object(p.requestId),
        tx.object(p.offerId),
        tx.object(this.cfg.registryId),
        tx.pure.vector('u8', hexBytes(p.proofHex)),
      ],
    });
    return this.execute(tx);
  }

  /** Pages through events emitted by `module` of the package, oldest first. */
  async listEvents(module: 'sla' | 'negotiation' | 'verifier', after: string | null, limit = 50) {
    const page = await this.client.listEvents({
      filter: { emitModule: `${this.cfg.packageId}::${module}` },
      after,
      limit,
      order: 'ascending',
    });
    const events: ChainEvent[] = page.events.map((e) => ({
      type: e.eventType,
      module: e.module,
      sender: e.sender,
      json: e.json,
      digest: e.transactionDigest,
      eventIndex: e.eventIndex,
      checkpoint: e.checkpoint,
    }));
    return { events, cursor: page.endCursor ?? after, hasNextPage: page.hasNextPage };
  }

  private requireSigner() {
    if (!this.signer) throw new Error('SUI_PRIVATE_KEY is required for on-chain writes');
    return this.signer;
  }

  private async execute(tx: Transaction): Promise<ExecutionReceipt> {
    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.requireSigner(),
      include: { effects: true },
    });
    const t = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
    await this.client.waitForTransaction({ digest: t.digest });
    const gas = t.effects?.gasUsed;
    const gasUsedMist = gas
      ? Number(gas.computationCost) + Number(gas.storageCost) - Number(gas.storageRebate)
      : 0;
    return {
      digest: t.digest,
      success: result.$kind === 'Transaction',
      error: result.$kind === 'FailedTransaction' ? JSON.stringify(t.status) : undefined,
      gasUsedMist,
    };
  }
}
