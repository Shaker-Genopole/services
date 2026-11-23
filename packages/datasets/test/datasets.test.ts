import { describe, expect, test } from 'vitest';
import {
  ECG_HEARTBEAT,
  edgeNodeProfiles,
  loadDatasets,
  parseCsv,
  parseEcgHeartbeat,
  parseGreenIotEdge,
  parseHealthcareIot,
  syntheticEdgeTasks,
} from '@zk-sla/datasets';

// Header and first rows as published in healthcare_iot_target_dataset.csv.
const VITALS_CSV = `Patient_ID,Timestamp,Sensor_ID,Sensor_Type,Temperature (°C),Systolic_BP (mmHg),Diastolic_BP (mmHg),Heart_Rate (bpm),Device_Battery_Level (%),Target_Blood_Pressure,Target_Heart_Rate,Target_Health_Status,Battery_Level (%)
8270,2024-01-01 00:00:00,4,Temperature,36.8,150.0,95.0,84.0,99,140.0,80,Healthy,99
1860,2024-01-01 01:00:00,1,Battery,37.3,150.0,95.0,77.0,84,140.0,80,Under Observation,84
`;

const GREEN_HEADER =
  'Task_ID,Device_ID,Edge_Node_ID,Sensor_Type,Task_Type,Task_Priority,Task_Size_MB,Instruction_Count_MI,CPU_Requirement_GHz,Memory_Requirement_MB,Bandwidth_Requirement_Mbps,Deadline_ms,Arrival_Rate,Queue_Length,Transmission_Distance_m,Network_Latency_ms,Packet_Loss_Percent,Signal_Strength_dBm,Available_CPU_Percent,Available_RAM_MB,Available_Bandwidth_Mbps,Edge_CPU_Utilization_Percent,Edge_RAM_Utilization_Percent,Storage_Utilization_Percent,Current_Energy_Level_Percent,Renewable_Energy_Input_W,Power_Consumption_W,Battery_Level_Percent,Temperature_C,Humidity_Percent,Energy_Consumption_J,Carbon_Emission_gCO2,Execution_Time_ms,Waiting_Time_ms,Response_Time_ms,Throughput_Mbps,Resource_Utilization_Percent,Task_Completion_Status,Network_Lifetime_Index,QoS_Score,Energy_Efficiency_Score,Allocation_Decision';
const greenRow = (id: string, node: string, latency: number) =>
  `${id},D1,${node},Temperature,Analytics,High,12,900,1.2,256,10,200,5,3,40,${latency},0.5,-60,55,4096,80,45,50,40,70,20,35,80,30,40,12,3,90,10,${latency + 100},20,60,Completed,0.8,0.91,0.7,Local Edge`;

describe('csv', () => {
  test('handles quotes, escaped quotes and CRLF', () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\r\n')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });
});

describe('kaggle adapters', () => {
  test('healthcare-iot-data maps the published columns', () => {
    const [r] = parseHealthcareIot(VITALS_CSV);
    expect(r).toMatchObject({
      patientId: '8270',
      sensorType: 'Temperature',
      temperatureC: 36.8,
      systolicMmHg: 150,
      diastolicMmHg: 95,
      heartRateBpm: 84,
      deviceBatteryPercent: 99,
      targetHealthStatus: 'Healthy',
    });
    expect(r!.timestamp).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
  });

  test('heartbeat rows are 187 samples plus a label', () => {
    const row = [...Array.from({ length: ECG_HEARTBEAT.beatLength }, (_, i) => (i === 0 ? 1 : 0.1)), 2].join(
      ',',
    );
    const [beat] = parseEcgHeartbeat(`${row}\n`);
    expect(beat!.signal).toHaveLength(187);
    expect(beat!.label).toBe(2);
    expect(() => parseEcgHeartbeat('1,2,3\n')).toThrow(/expected 188/);
  });

  test('green iot edge dataset maps the published columns', () => {
    const [r] = parseGreenIotEdge(`${GREEN_HEADER}\n${greenRow('T1', 'EN01', 12.5)}\n`);
    expect(r).toMatchObject({
      edgeNodeId: 'EN01',
      networkLatencyMs: 12.5,
      responseTimeMs: 112.5,
      completed: true,
      qosScore: 0.91,
    });
  });
});

describe('edge node profiles', () => {
  test('aggregate per node with a p95 latency commitment', () => {
    const csv = [
      GREEN_HEADER,
      ...Array.from({ length: 20 }, (_, i) => greenRow(`T${i}`, 'EN01', i + 1)),
    ].join('\n');
    const [profile] = edgeNodeProfiles(parseGreenIotEdge(csv));
    expect(profile).toMatchObject({ edgeNodeId: 'EN01', tasks: 20, latencyP95Ms: 19, completionRate: 1 });
    expect(profile!.storageGb).toBe(Math.round(2048 * 0.6));
    expect(profile!.cpuMillicores).toBe(Math.round(16_000 * 0.55));
  });

  test('synthetic tasks produce one profile per node', () => {
    expect(edgeNodeProfiles(syntheticEdgeTasks(600, 1, 4))).toHaveLength(4);
  });
});

describe('loadDatasets', () => {
  test('falls back to synthetic data when CSVs are missing', () => {
    const d = loadDatasets('/definitely/missing');
    expect(d.vitals.source).toBe('synthetic');
    expect(d.heartbeats.records[0]!.signal).toHaveLength(187);
    expect(d.edgeTasks.records.length).toBeGreaterThan(0);
  });
});
