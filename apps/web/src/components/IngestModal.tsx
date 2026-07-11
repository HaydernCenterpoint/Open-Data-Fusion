import { CheckCircle2, Database, LoaderCircle, UploadCloud, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { ingestBundle } from "../lib/api";

interface IngestModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: (message: string) => void;
}

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.tabIndex >= 0 && !element.hidden);
}

export function IngestModal({ open, onClose, onComplete }: IngestModalProps) {
  const [sourceSystem, setSourceSystem] = useState("OSIsoft PI");
  const [runId, setRunId] = useState(`manual-${Date.now()}`);
  const [value, setValue] = useState("111.2");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const firstField = useRef<HTMLSelectElement>(null);
  const successAction = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setStatus("idle");
    setError("");
    setRunId(`manual-${Date.now()}`);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusableElements = getFocusableElements(dialog);
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      const focusIsOutside = !activeElement || !dialog.contains(activeElement);
      if (event.shiftKey && (focusIsOutside || activeElement === firstElement)) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && (focusIsOutside || activeElement === lastElement)) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !(event.target instanceof Node) || dialog.contains(event.target)) return;
      (firstField.current ?? getFocusableElements(dialog)[0] ?? dialog).focus();
    };

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      const elementToRestore = previouslyFocused.current;
      previouslyFocused.current = null;
      if (elementToRestore?.isConnected) elementToRestore.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (status === "idle") (firstField.current ?? dialogRef.current)?.focus();
    if (status === "success") (successAction.current ?? dialogRef.current)?.focus();
  }, [open, status]);

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
      <div ref={dialogRef} className="ingest-modal" role="dialog" aria-modal="true" aria-labelledby="ingest-title" aria-describedby="ingest-description" tabIndex={-1}>
        <div className="modal-header">
          <div className="modal-title-icon"><UploadCloud size={22} /></div>
          <div><h2 id="ingest-title">Ingest sample bundle</h2><p id="ingest-description">Send a reproducible P-101 demonstration bundle to Open Data Fusion.</p></div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close ingest dialog"><X size={20} /></button>
        </div>
        {status === "success" ? (
          <div className="success-panel">
            <CheckCircle2 size={44} />
            <h3>Bundle accepted</h3>
            <p>The P-101 asset, pressure series, and latest data point are queued for processing.</p>
            <button ref={successAction} type="button" className="primary-button" onClick={onClose}>Done</button>
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
