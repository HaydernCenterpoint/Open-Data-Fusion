import { CheckCircle2, Database, LoaderCircle, UploadCloud, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { ingestBundle } from "../lib/api";

interface IngestModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: (message: string) => void;
}

export function IngestModal({ open, onClose, onComplete }: IngestModalProps) {
  const [sourceSystem, setSourceSystem] = useState("OSIsoft PI");
  const [runId, setRunId] = useState(`manual-${Date.now()}`);
  const [value, setValue] = useState("111.2");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const firstField = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (!open) return;
    setStatus("idle");
    setError("");
    setRunId(`manual-${Date.now()}`);
    requestAnimationFrame(() => firstField.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStatus("submitting");
    setError("");
    try {
      const result = await ingestBundle({
        source: { system: sourceSystem, runId, actor: "harper.dennis" },
        assets: [
          {
            externalId: "P-101",
            name: "Pump P-101",
            type: "Centrifugal Pump",
            parentExternalId: "AREA-A",
            metadata: { site: "North Plant" },
          },
        ],
        timeSeries: [
          { externalId: "P-101-PRESSURE", assetExternalId: "P-101", name: "Pressure", unit: "psi" },
        ],
        dataPoints: [
          {
            timeSeriesExternalId: "P-101-PRESSURE",
            timestamp: new Date().toISOString(),
            value: Number(value),
            quality: "good",
          },
        ],
      });
      setStatus("success");
      onComplete(result.message || `Ingest run ${result.runId || runId} accepted`);
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "The ingest request could not be completed.");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="ingest-modal" role="dialog" aria-modal="true" aria-labelledby="ingest-title">
        <div className="modal-header">
          <div className="modal-title-icon"><UploadCloud size={22} /></div>
          <div><h2 id="ingest-title">Ingest data</h2><p>Send a small industrial data bundle to Open Data Fusion.</p></div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close ingest dialog"><X size={20} /></button>
        </div>
        {status === "success" ? (
          <div className="success-panel">
            <CheckCircle2 size={44} />
            <h3>Bundle accepted</h3>
            <p>The P-101 asset, pressure series, and latest data point are queued for processing.</p>
            <button type="button" className="primary-button" onClick={onClose}>Done</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="form-grid">
              <label>
                Source system
                <select ref={firstField} value={sourceSystem} onChange={(event) => setSourceSystem(event.target.value)}>
                  <option>OSIsoft PI</option>
                  <option>SAP PM</option>
                  <option>Manual upload</option>
                </select>
              </label>
              <label>
                Source run ID
                <input required value={runId} onChange={(event) => setRunId(event.target.value)} />
              </label>
              <label className="asset-preview-label">
                Asset bundle
                <span className="asset-preview"><Database size={18} /><span><strong>Pump P-101</strong><small>1 asset · 1 time series · 1 data point</small></span></span>
              </label>
              <label>
                Latest pressure (psi)
                <input type="number" min="0" step="0.1" required value={value} onChange={(event) => setValue(event.target.value)} />
              </label>
            </div>
            {status === "error" && <div className="form-error" role="alert">{error}</div>}
            <div className="modal-footer">
              <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
              <button type="submit" className="primary-button" disabled={status === "submitting"}>
                {status === "submitting" ? <><LoaderCircle className="spin" size={17} /> Sending bundle…</> : <><UploadCloud size={17} /> Start ingest</>}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
