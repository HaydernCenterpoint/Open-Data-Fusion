import { CheckCircle2, Database, LoaderCircle, UploadCloud, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { ingestBundle } from "../lib/api";
import type { PlatformContext } from "../types";

interface IngestModalProps {
  open: boolean;
  context: PlatformContext | null;
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

export function IngestModal({ open, context, onClose, onComplete }: IngestModalProps) {
  const [sourceSystem, setSourceSystem] = useState("");
  const [runId, setRunId] = useState(`manual-${Date.now()}`);
  const [assetExternalId, setAssetExternalId] = useState("");
  const [assetName, setAssetName] = useState("");
  const [assetType, setAssetType] = useState("");
  const [seriesExternalId, setSeriesExternalId] = useState("");
  const [seriesName, setSeriesName] = useState("");
  const [unit, setUnit] = useState("");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const firstField = useRef<HTMLInputElement>(null);
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
      if (!context) throw new Error("Select a tenant and project before ingesting data.");
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) throw new Error("The measurement value must be a finite number.");
      const result = await ingestBundle(context, {
        source: { system: sourceSystem, runId },
        assets: [
          {
            externalId: assetExternalId,
            name: assetName,
            type: assetType,
          },
        ],
        timeSeries: [
          { externalId: seriesExternalId, assetExternalId, name: seriesName, unit: unit || undefined },
        ],
        dataPoints: [
          {
            timeSeriesExternalId: seriesExternalId,
            timestamp: new Date().toISOString(),
            value: numericValue,
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
          <div><h2 id="ingest-title">Ingest measurement bundle</h2><p id="ingest-description">Create or update a real asset and time series in the selected project.</p></div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close ingest dialog"><X size={20} /></button>
        </div>
        {status === "success" ? (
          <div className="success-panel">
            <CheckCircle2 size={44} />
            <h3>Bundle accepted</h3>
            <p>{assetExternalId} and {seriesExternalId} were accepted for {context?.tenantId} / {context?.projectId}.</p>
            <button ref={successAction} type="button" className="primary-button" onClick={onClose}>Done</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="form-grid">
              <label>
                Source system
                <input ref={firstField} required value={sourceSystem} onChange={(event) => setSourceSystem(event.target.value)} placeholder="opcua-line-1" />
              </label>
              <label>
                Source run ID
                <input required value={runId} onChange={(event) => setRunId(event.target.value)} />
              </label>
              <label>
                Asset external ID
                <input required value={assetExternalId} onChange={(event) => setAssetExternalId(event.target.value)} placeholder="PUMP-201" />
              </label>
              <label>
                Asset name
                <input required value={assetName} onChange={(event) => setAssetName(event.target.value)} placeholder="Cooling pump 201" />
              </label>
              <label>
                Asset type
                <input required value={assetType} onChange={(event) => setAssetType(event.target.value)} placeholder="Pump" />
              </label>
              <label>
                Time-series external ID
                <input required value={seriesExternalId} onChange={(event) => setSeriesExternalId(event.target.value)} placeholder="PUMP-201-PRESSURE" />
              </label>
              <label>
                Time-series name
                <input required value={seriesName} onChange={(event) => setSeriesName(event.target.value)} placeholder="Discharge pressure" />
              </label>
              <label>
                Unit
                <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="bar" />
              </label>
              <label className="asset-preview-label">
                Target project
                <span className="asset-preview"><Database size={18} /><span><strong>{context ? `${context.tenantId} / ${context.projectId}` : "No project selected"}</strong><small>1 asset · 1 time series · 1 data point</small></span></span>
              </label>
              <label>
                Measurement value
                <input type="number" step="any" required value={value} onChange={(event) => setValue(event.target.value)} />
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
