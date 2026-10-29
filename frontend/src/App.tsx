import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJunctionHistory, getJunctionStatus, getSimulatorStatus, submitManualCommand, submitSensorEvent, updateSimulator } from "./api";
import { nextSequence } from "./sequence";
import type { Direction, JunctionStatus, Phase, SignalColor, SimulatorStatus, VehicleType } from "./types";

const DIRECTIONS: Direction[] = ["NORTH", "EAST", "SOUTH", "WEST"];
const PHASES: Phase[] = ["NORTH_SOUTH", "EAST_WEST"];
const VEHICLE_TYPES: VehicleType[] = ["EMPLOYEE_VEHICLE", "FORKLIFT", "TRUCK", "EMERGENCY"];

export default function App() {
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<Direction>("NORTH");
  const [vehicleType, setVehicleType] = useState<VehicleType>("EMPLOYEE_VEHICLE");
  const [vehicleId, setVehicleId] = useState("");
  const [sensorAction, setSensorAction] = useState<"ARRIVAL" | "CLEARANCE">("ARRIVAL");
  const [ackDelay, setAckDelay] = useState<number | null>(null);
  const [notice, setNotice] = useState("");

  const statusQuery = useQuery({
    queryKey: ["junction-status", "A"],
    queryFn: () => getJunctionStatus("A"),
    refetchInterval: 1_000,
  });
  const historyQuery = useQuery({
    queryKey: ["junction-history", "A"],
    queryFn: () => getJunctionHistory("A"),
    refetchInterval: 3_000,
  });
  const simulatorQuery = useQuery({
    queryKey: ["simulator-status", "A"],
    queryFn: () => getSimulatorStatus("A"),
    refetchInterval: 3_000,
  });

  const sensorMutation = useMutation({
    mutationFn: submitSensorEvent,
    onSuccess: (result) => {
      setNotice(result.duplicate ? "This event was already processed; the queue was not changed again." : "Sensor event accepted by the API.");
      refreshDashboard(queryClient);
    },
  });
  const manualMutation = useMutation({
    mutationFn: submitManualCommand,
    onSuccess: () => {
      setNotice("Control intent recorded. Signal changes still follow the safe controller sequence.");
      refreshDashboard(queryClient);
    },
  });
  const simulatorMutation = useMutation({
    mutationFn: updateSimulator,
    onSuccess: () => {
      setNotice("Simulator settings updated.");
      refreshDashboard(queryClient);
    },
  });

  const status = statusQuery.data;
  const simulator = simulatorQuery.data;
  const unavailable = status?.stage === "FAULT_LOCKOUT";
  const controlNotice = status?.physical_state_trust !== "CONFIRMED"
    ? "Controller state is not confirmed. Intents may wait for reconciliation."
    : status.mode === "EMERGENCY"
      ? "Emergency traffic currently has priority over manual control."
      : null;

  function handleSensorSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const cleanVehicleId = vehicleId.trim();
    if (cleanVehicleId.length === 0) {
      setNotice("Enter a vehicle ID first.");
      return;
    }
    sensorMutation.mutate({
      direction,
      eventType: sensorAction === "ARRIVAL" ? "VEHICLE_ARRIVED" : "VEHICLE_CLEARED",
      vehicleId: cleanVehicleId,
      vehicleType,
      sequenceNo: nextSequence(direction, statusQuery.data?.sequence_cursors[direction] ?? 0),
    });
  }

  function handleDelaySubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    simulatorMutation.mutate({ ack_delay_ms: Math.min(60_000, Math.max(0, Math.round(ackDelay ?? simulator?.ack_delay_ms ?? 0))) });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">FT</div>
          <div>
            <p className="eyebrow">FACTORY TRAFFIC SYSTEM</p>
            <h1>Junction control</h1>
          </div>
        </div>
        <div className="topbar-meta">
          <span className={`connection-tag ${statusQuery.isPending ? "connection-pending" : statusQuery.isError ? "connection-offline" : "connection-online"}`} role="status">
            <span className="pulse-dot" aria-hidden="true" />
            {statusQuery.isPending ? "Connecting" : statusQuery.isError ? "API offline" : "API connected"}
          </span>
          <span className="junction-tag">Junction A</span>
          <span className="updated-at">{status?.actual_observed_at ? `${statusQuery.isError ? "Cached report" : "Last controller report"} ${formatTime(status.actual_observed_at)}` : "Waiting for controller report"}</span>
        </div>
      </header>

      {statusQuery.isError && <div className="banner banner-critical" role="alert">API connection lost. Showing cached status; lamp colors are marked unknown until a fresh report arrives.</div>}
      {status?.alerts.map((alert) => (
        <div className={`banner ${alert.severity === "CRITICAL" ? "banner-critical" : "banner-warning"}`} key={`${alert.code}-${alert.message}`} role="status">
          <strong>{humanize(alert.code)}</strong><span>{alert.message}</span>
        </div>
      ))}

      {statusQuery.isPending ? (
        <section className="loading-card"><span className="spinner" /> Connecting to Junction A…</section>
      ) : status === undefined ? (
        <section className="loading-card error-card">Junction status is unavailable. Check the backend and try again.</section>
      ) : (
        <>
          <section className="summary-grid" aria-label="Junction summary">
            <SummaryCard label="Operating mode" value={humanize(status.mode)} detail={status.mode === "EMERGENCY" ? "Emergency intent active" : status.mode === "MANUAL" ? "Time-limited operator lease" : "Policy-selected traffic"} tone={status.mode.toLowerCase()} />
          <SummaryCard label="Controller" value={humanize(status.controller_status)} detail={statusQuery.isError ? "Cached status · reconnecting" : status.physical_state_trust === "CONFIRMED" ? "State confirmed" : `State ${status.physical_state_trust.toLowerCase()}`} tone={statusQuery.isError ? "warning" : status.controller_status.toLowerCase()} />
            <SummaryCard label="Current stage" value={humanize(status.stage)} detail={status.stage_deadline_at ? `Stage deadline ${formatTime(status.stage_deadline_at)}` : "No active timer"} />
            <SummaryCard label="Next phase" value={status.phase_policy.next_phase ? phaseLabel(status.phase_policy.next_phase) : "No queued phase"} detail={status.phase_policy.emergency_phase ? "Selected by emergency priority" : `Policy revision ${status.intent_revision}`} tone={status.phase_policy.emergency_phase ? "emergency" : undefined} />
          </section>

          <div className="main-grid">
            <div className="primary-column">
              <section className="panel intersection-panel">
                <div className="section-heading">
                  <div><p className="eyebrow">LIVE JUNCTION</p><h2>Four-way intersection</h2></div>
                  <TrustPill trust={statusQuery.isError ? "STALE" : status.physical_state_trust} />
                </div>
                <div className="intersection-wrap">
                  <div className="road-horizontal" />
                  <div className="road-vertical" />
                  <div className="road-center"><span>JUNCTION<br />A</span></div>
                  {DIRECTIONS.map((item) => (
                    <div className={`signal-position signal-${item.toLowerCase()}`} key={item}>
                      <Signal direction={item} actual={statusQuery.isError ? null : status.actual_signals} trust={statusQuery.isError ? "STALE" : status.physical_state_trust} desired={status.desired_signals[item]} queue={status.queues[item]} />
                    </div>
                  ))}
                </div>
                <div className="signal-legend"><span><i className="legend-dot confirmed" /> Controller-reported</span><span><i className="legend-dot desired" /> Requested separately below</span></div>
                <div className="signal-comparison">
                  <div><span className="comparison-label">Desired vector</span><Vector signals={status.desired_signals} /></div>
                  <div><span className="comparison-label">Observed vector</span><Vector signals={statusQuery.isError ? null : status.actual_signals} /></div>
                </div>
              </section>

              <section className="panel queue-panel">
                <div className="section-heading"><div><p className="eyebrow">AUTOMATIC POLICY</p><h2>Queue pressure</h2></div><span className="small-note">Weights + age bonus</span></div>
                <div className="phase-score-grid">
                  {PHASES.map((phase) => {
                    const queue = status.phase_policy.phases[phase];
                    return <article className={`phase-score ${status.phase_policy.next_phase === phase ? "phase-selected" : ""}`} key={phase}>
                      <div className="phase-score-top"><strong>{phaseLabel(phase)}</strong><span>Score {queue.weightedScore}</span></div>
                      <div className="queue-meter"><span style={{ width: `${Math.min(100, queue.count * 12)}%` }} /></div>
                      <p>{queue.count} vehicles <span>·</span> oldest wait {formatDuration(queue.oldestWaitMs)}</p>
                    </article>;
                  })}
                </div>
              </section>

              <section className="panel activity-panel">
                <div className="section-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Recent activity</h2></div><button className="quiet-button" onClick={() => void historyQuery.refetch()} type="button">Refresh</button></div>
                {historyQuery.isError && <p className="inline-error">Activity history could not be loaded.</p>}
                {historyQuery.isPending ? <p className="empty-state">Loading recent events…</p> : historyQuery.data?.events.length === 0 ? <p className="empty-state">No activity recorded yet.</p> : (
                  <ol className="activity-list">
                    {historyQuery.data?.events.map((event) => (
                      <li className="activity-item" key={event.id}>
                        <span className="activity-mark" aria-hidden="true" />
                        <div className="activity-body"><div><strong>{humanize(event.kind)}</strong><time>{formatTime(event.occurred_at)}</time></div><p>{summarizePayload(event.payload)}</p></div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>

            <aside className="side-column">
              <section className="panel control-panel">
                <div className="section-heading"><div><p className="eyebrow">OPERATOR CONTROL</p><h2>Manual phase</h2></div><span className="unprotected-label">UNPROTECTED DEMO</span></div>
                {controlNotice && <p className="control-note">{controlNotice}</p>}
                {status.manual_lease_expires_at && <p className="lease-line">Lease expires <strong>{formatTime(status.manual_lease_expires_at)}</strong></p>}
                <div className="direction-buttons">
                  {DIRECTIONS.map((item) => <button key={item} type="button" disabled={unavailable || manualMutation.isPending} onClick={() => manualMutation.mutate({ command_type: "MANUAL_GREEN_REQUEST", direction: item })}><span>{item.slice(0, 1)}</span>{humanize(item)}</button>)}
                </div>
                <button className="secondary-button full-width" type="button" disabled={unavailable || manualMutation.isPending} onClick={() => manualMutation.mutate({ command_type: "RETURN_TO_AUTOMATIC" })}>Return to automatic</button>
                {unavailable && <p className="inline-error">Controls are locked while the junction is in fault lockout.</p>}
              </section>

              <section className="panel simulation-panel">
                <div className="section-heading"><div><p className="eyebrow">SENSOR SIMULATOR</p><h2>Vehicle event</h2></div><span className="panel-index">01</span></div>
                <form className="stacked-form" onSubmit={handleSensorSubmit}>
                  <label>Event<select value={sensorAction} onChange={(event) => setSensorAction(event.target.value === "CLEARANCE" ? "CLEARANCE" : "ARRIVAL")}><option value="ARRIVAL">Vehicle arrival</option><option value="CLEARANCE">Vehicle clearance</option></select></label>
                  <div className="form-row"><label>Direction<select value={direction} onChange={(event) => setDirection(parseDirection(event.target.value))}>{DIRECTIONS.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></label><label>Vehicle type<select value={vehicleType} onChange={(event) => setVehicleType(parseVehicleType(event.target.value))}>{VEHICLE_TYPES.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></label></div>
                  <label>Vehicle ID<input maxLength={100} onChange={(event) => setVehicleId(event.target.value)} placeholder="e.g. TRK-204" value={vehicleId} /></label>
                  <button className="primary-button full-width" disabled={sensorMutation.isPending} type="submit">{sensorMutation.isPending ? "Sending event…" : sensorAction === "ARRIVAL" ? "Record arrival" : "Record clearance"}</button>
                </form>
              </section>

              <SimulatorPanel simulator={simulator} mutationPending={simulatorMutation.isPending} ackDelay={ackDelay} setAckDelay={setAckDelay} onUpdate={(value) => simulatorMutation.mutate(value)} onDelaySubmit={handleDelaySubmit} />
              {simulatorQuery.isError && <p className="inline-error">Simulator controls are unavailable.</p>}
            </aside>
          </div>
        </>
      )}

      {(notice || sensorMutation.isError || manualMutation.isError || simulatorMutation.isError) && (
        <div className={`toast ${sensorMutation.isError || manualMutation.isError || simulatorMutation.isError ? "toast-error" : ""}`} role="status">
          {sensorMutation.error?.message ?? manualMutation.error?.message ?? simulatorMutation.error?.message ?? notice}
          <button type="button" aria-label="Dismiss message" onClick={() => { setNotice(""); sensorMutation.reset(); manualMutation.reset(); simulatorMutation.reset(); }}>×</button>
        </div>
      )}
      <footer className="page-footer"><span>Simulation only · Controller reports are not proof of physical lamp state.</span><span>Junction A · single-controller demo</span></footer>
    </main>
  );
}

function SummaryCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: string }) {
  return <article className="summary-card"><span className="summary-label">{label}</span><strong className={tone ? `tone-${tone}` : ""}>{value}</strong><span className="summary-detail">{detail}</span></article>;
}

function TrustPill({ trust }: { trust: JunctionStatus["physical_state_trust"] }) {
  return <span className={`trust-pill trust-${trust.toLowerCase()}`}><i />{trust === "CONFIRMED" ? "Fresh report" : humanize(trust)}</span>;
}

function Signal({ direction, actual, trust, desired, queue }: { direction: Direction; actual: JunctionStatus["actual_signals"]; trust: JunctionStatus["physical_state_trust"]; desired: SignalColor; queue: number }) {
  const actualColor = trust === "CONFIRMED" ? actual?.[direction] ?? "UNKNOWN" : "UNKNOWN";
  return <div className="signal-card"><div className={`lamp lamp-${actualColor.toLowerCase()}`} role="img" aria-label={`${direction} controller-reported ${actualColor.toLowerCase()}`}><span /></div><strong>{direction}</strong><span className="signal-queue">{queue} waiting</span><span className="signal-desired">Requested {desired.toLowerCase()}</span></div>;
}

function Vector({ signals }: { signals: JunctionStatus["actual_signals"] | JunctionStatus["desired_signals"] }) {
  if (signals === null) return <span className="vector-unknown">Unknown · no fresh controller report</span>;
  return <div className="vector-row">{DIRECTIONS.map((direction) => <span key={direction}><i className={`mini-lamp mini-${signals[direction].toLowerCase()}`} />{direction.slice(0, 1)} {signals[direction]}</span>)}</div>;
}

function SimulatorPanel({
  simulator,
  mutationPending,
  ackDelay,
  setAckDelay,
  onUpdate,
  onDelaySubmit,
}: {
  simulator: SimulatorStatus | undefined;
  mutationPending: boolean;
  ackDelay: number | null;
  setAckDelay: (delay: number) => void;
  onUpdate: (value: Parameters<typeof updateSimulator>[0]) => void;
  onDelaySubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <section className="panel simulation-panel">
    <div className="section-heading"><div><p className="eyebrow">CONTROLLER SIMULATOR</p><h2>Device behavior</h2></div><span className={`sim-state ${simulator?.health === "ONLINE" ? "sim-online" : simulator?.health === "OFFLINE" ? "sim-offline" : "sim-unavailable"}`}><i />{simulator ? humanize(simulator.health) : "Unavailable"}</span></div>
    <div className="simulator-controls">
      <div className="toggle-row"><div><strong>Automatic ACK</strong><span>Confirm requested vectors automatically</span></div><button className={`toggle ${simulator?.automatic_ack ? "toggle-on" : ""}`} type="button" role="switch" aria-label="Automatic controller acknowledgements" aria-checked={simulator?.automatic_ack ?? false} disabled={!simulator || mutationPending} onClick={() => onUpdate({ automatic_ack: !simulator?.automatic_ack })}><span /></button></div>
      <div className="sim-control-row"><label htmlFor="ack-delay">ACK delay</label><form onSubmit={onDelaySubmit}><input id="ack-delay" type="number" min="0" max="60000" step="250" value={ackDelay ?? simulator?.ack_delay_ms ?? 0} onChange={(event) => setAckDelay(Number(event.target.value))} /><span>ms</span><button type="submit" disabled={!simulator || mutationPending}>Set</button></form></div>
      <label className="behavior-label">Next ACK behavior<select value={simulator?.next_ack_behavior ?? "NORMAL"} disabled={!simulator || mutationPending} onChange={(event) => onUpdate({ next_ack_behavior: parseAckBehavior(event.target.value) })}><option value="NORMAL">Normal</option><option value="DROP">Drop ACK</option><option value="DUPLICATE">Duplicate ACK</option><option value="MISMATCH">Mismatched state</option></select></label>
      <div className="device-buttons"><button type="button" disabled={!simulator || mutationPending || simulator?.health === "ONLINE"} onClick={() => onUpdate({ health: "ONLINE" })}>Reconnect</button><button type="button" disabled={!simulator || mutationPending || simulator?.health === "OFFLINE"} onClick={() => onUpdate({ health: "OFFLINE" })}>Take offline</button></div>
    </div>
  </section>;
}

function refreshDashboard(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["junction-status", "A"] });
  void queryClient.invalidateQueries({ queryKey: ["junction-history", "A"] });
  void queryClient.invalidateQueries({ queryKey: ["simulator-status", "A"] });
}

function parseDirection(value: string): Direction {
  return DIRECTIONS.find((direction) => direction === value) ?? "NORTH";
}

function parseVehicleType(value: string): VehicleType {
  return VEHICLE_TYPES.find((vehicleType) => vehicleType === value) ?? "EMPLOYEE_VEHICLE";
}

function parseAckBehavior(value: string): SimulatorStatus["next_ack_behavior"] {
  switch (value) {
    case "DROP": return "DROP";
    case "DUPLICATE": return "DUPLICATE";
    case "MISMATCH": return "MISMATCH";
    default: return "NORMAL";
  }
}

function humanize(value: string): string {
  return value.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function phaseLabel(phase: string): string {
  return phase === "NORTH_SOUTH" ? "North ↔ South" : "East ↔ West";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function summarizePayload(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return String(payload);
  const details = Object.entries(payload).slice(0, 4).map(([key, value]) => `${humanize(key)}: ${String(value)}`);
  return details.length > 0 ? details.join(" · ") : "No additional event details";
}

