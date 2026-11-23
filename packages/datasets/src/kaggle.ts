// Adapters for the Kaggle datasets the platform is calibrated on. Column names
// match the published CSV headers exactly.
import { num, parseCsv, parseCsvRecords } from './csv.js';

// ---- ziya07/healthcare-iot-data (CC0) ------------------------------------------
// File: healthcare_iot_target_dataset.csv

export const HEALTHCARE_IOT = {
  slug: 'ziya07/healthcare-iot-data',
  file: 'healthcare_iot_target_dataset.csv',
  license: 'CC0-1.0',
} as const;

export interface VitalsRecord {
  patientId: string;
  timestamp: number;
  sensorId: string;
  sensorType: string;
  temperatureC: number;
  systolicMmHg: number;
  diastolicMmHg: number;
  heartRateBpm: number;
  deviceBatteryPercent: number;
  targetHealthStatus?: string;
  batteryPercent: number;
}

export function parseHealthcareIot(text: string): VitalsRecord[] {
  return parseCsvRecords(text).map((r) => ({
    patientId: r['Patient_ID']!,
    timestamp: Date.parse(`${r['Timestamp']!.replace(' ', 'T')}Z`),
    sensorId: r['Sensor_ID']!,
    sensorType: r['Sensor_Type']!,
    temperatureC: num(r['Temperature (°C)'], 'Temperature (°C)'),
    systolicMmHg: num(r['Systolic_BP (mmHg)'], 'Systolic_BP (mmHg)'),
    diastolicMmHg: num(r['Diastolic_BP (mmHg)'], 'Diastolic_BP (mmHg)'),
    heartRateBpm: num(r['Heart_Rate (bpm)'], 'Heart_Rate (bpm)'),
    deviceBatteryPercent: num(r['Device_Battery_Level (%)'], 'Device_Battery_Level (%)'),
    targetHealthStatus: r['Target_Health_Status'] || undefined,
    batteryPercent: num(r['Battery_Level (%)'] ?? r['Device_Battery_Level (%)'], 'Battery_Level (%)'),
  }));
}

// ---- shayanfazeli/heartbeat (MIT-BIH portion) ------------------------------------
// Files: mitbih_train.csv / mitbih_test.csv, no header, 187 samples @125 Hz + label.

export const ECG_HEARTBEAT = {
  slug: 'shayanfazeli/heartbeat',
  files: ['mitbih_train.csv', 'mitbih_test.csv'],
  sampleRateHz: 125,
  beatLength: 187,
  classes: ['N', 'S', 'V', 'F', 'Q'] as const,
  classNames: ['normal', 'supraventricular ectopic', 'ventricular ectopic', 'fusion', 'unknown'] as const,
} as const;

export interface HeartbeatRecord {
  signal: number[];
  label: number;
}

export function parseEcgHeartbeat(text: string, limit = Infinity): HeartbeatRecord[] {
  const out: HeartbeatRecord[] = [];
  for (const row of parseCsv(text)) {
    if (out.length >= limit) break;
    if (row.length !== ECG_HEARTBEAT.beatLength + 1) {
      throw new Error(`heartbeat row has ${row.length} columns, expected ${ECG_HEARTBEAT.beatLength + 1}`);
    }
    const values = row.map(Number);
    out.push({ signal: values.slice(0, -1), label: Math.round(values.at(-1)!) });
  }
  return out;
}

// ---- colabsss/green-iot-edge-resource-dataset (CC0) ------------------------------
// File: Green_IoT_Edge_Resource_Allocation_Dataset.csv

export const GREEN_IOT_EDGE = {
  slug: 'colabsss/green-iot-edge-resource-dataset',
  file: 'Green_IoT_Edge_Resource_Allocation_Dataset.csv',
  license: 'CC0-1.0',
} as const;

export interface EdgeTaskRecord {
  taskId: string;
  edgeNodeId: string;
  sensorType: string;
  networkLatencyMs: number;
  responseTimeMs: number;
  packetLossPercent: number;
  availableCpuPercent: number;
  availableRamMb: number;
  storageUtilizationPercent: number;
  batteryLevelPercent: number;
  powerConsumptionW: number;
  qosScore: number;
  completed: boolean;
  allocationDecision: string;
}

export function parseGreenIotEdge(text: string): EdgeTaskRecord[] {
  return parseCsvRecords(text).map((r) => ({
    taskId: r['Task_ID']!,
    edgeNodeId: r['Edge_Node_ID']!,
    sensorType: r['Sensor_Type']!,
    networkLatencyMs: num(r['Network_Latency_ms'], 'Network_Latency_ms'),
    responseTimeMs: num(r['Response_Time_ms'], 'Response_Time_ms'),
    packetLossPercent: num(r['Packet_Loss_Percent'], 'Packet_Loss_Percent'),
    availableCpuPercent: num(r['Available_CPU_Percent'], 'Available_CPU_Percent'),
    availableRamMb: num(r['Available_RAM_MB'], 'Available_RAM_MB'),
    storageUtilizationPercent: num(r['Storage_Utilization_Percent'], 'Storage_Utilization_Percent'),
    batteryLevelPercent: num(r['Battery_Level_Percent'], 'Battery_Level_Percent'),
    powerConsumptionW: num(r['Power_Consumption_W'], 'Power_Consumption_W'),
    qosScore: num(r['QoS_Score'], 'QoS_Score'),
    completed: /^(1|true|success|completed)$/i.test(r['Task_Completion_Status'] ?? ''),
    allocationDecision: r['Allocation_Decision'] ?? '',
  }));
}
