import { CheckCircle2, FileSpreadsheet, LoaderCircle, Plus, Trash2, UploadCloud } from "lucide-react";
import { ChangeEvent, FormEvent, RefObject, useEffect, useMemo, useRef, useState } from "react";

import { ingestBundle } from "../lib/api";
import {
  buildCsvIngestBundle,
  parseDelimitedText,
  type CsvDelimiter,
  type CsvIngestMapping,
  type DelimitedTable,
} from "../lib/csvIngest";
import type { PlatformContext } from "../types";

interface CsvIngestFormProps {
  context: PlatformContext | null;
  onCancel: () => void;
  onComplete: (message: string) => void;
  fileInputRef?: RefObject<HTMLInputElement>;
}

interface AssetDraft {
  key: number;
  externalId: string;
  name: string;
  type: string;
}

interface SeriesDraft {
  key: number;
  externalId: string;
  assetExternalId: string;
  name: string;
  unit: string;
  valueColumn: string;
  qualityColumn: string;
}

function blankAsset(key: number): AssetDraft {
  return { key, externalId: "", name: "", type: "" };
}

function blankSeries(key: number): SeriesDraft {
  return {
    key,
    externalId: "",
    assetExternalId: "",
    name: "",
    unit: "",
    valueColumn: "",
    qualityColumn: "",
  };
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export function CsvIngestForm({ context, onCancel, onComplete, fileInputRef }: CsvIngestFormProps) {
  const localFileInputRef = useRef<HTMLInputElement>(null);
  const resolvedFileInputRef = fileInputRef ?? localFileInputRef;
  const successActionRef = useRef<HTMLButtonElement>(null);
  const readVersion = useRef(0);
  const nextDraftKey = useRef(2);
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [delimiter, setDelimiter] = useState<CsvDelimiter>(",");
  const [table, setTable] = useState<DelimitedTable | null>(null);
  const [fileError, setFileError] = useState("");
  const [sourceSystem, setSourceSystem] = useState("");
  const [runId, setRunId] = useState("");
  const [timestampColumn, setTimestampColumn] = useState("");
  const [assets, setAssets] = useState<AssetDraft[]>([blankAsset(0)]);
  const [timeSeries, setTimeSeries] = useState<SeriesDraft[]>([blankSeries(1)]);
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [requestError, setRequestError] = useState("");
  const [successSummary, setSuccessSummary] = useState("");

  useEffect(() => {
    if (status === "success") successActionRef.current?.focus();
  }, [status]);

  function resetMapping() {
    setSourceSystem("");
    setRunId("");
    setTimestampColumn("");
    setAssets([blankAsset(0)]);
    setTimeSeries([blankSeries(1)]);
    nextDraftKey.current = 2;
    setStatus("idle");
    setRequestError("");
    setSuccessSummary("");
  }

  async function readSelectedFile(selectedFile: File, selectedDelimiter: CsvDelimiter) {
    const version = readVersion.current + 1;
    readVersion.current = version;
    setTable(null);
    setFileError("");
    resetMapping();

    try {
      const text = await selectedFile.text();
      if (readVersion.current !== version) return;
      const parsed = parseDelimitedText(text, selectedDelimiter);
      setTable(parsed);
      setTimestampColumn(parsed.headers[0] ?? "");
    } catch (cause) {
      if (readVersion.current !== version) return;
      setFileError(errorMessage(cause, "The selected file could not be read."));
    }
  }

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] ?? null;
    setFile(selectedFile);
    setFileName(selectedFile?.name ?? "");
    if (selectedFile) {
      void readSelectedFile(selectedFile, delimiter);
    } else {
      readVersion.current += 1;
      setTable(null);
      setFileError("");
      resetMapping();
    }
  }

  function selectDelimiter(event: ChangeEvent<HTMLSelectElement>) {
    const selectedDelimiter = event.target.value as CsvDelimiter;
    setDelimiter(selectedDelimiter);
    if (file) void readSelectedFile(file, selectedDelimiter);
  }

  function updateAsset(key: number, patch: Partial<Omit<AssetDraft, "key">>) {
    setAssets((current) => current.map((asset) => asset.key === key ? { ...asset, ...patch } : asset));
  }

  function updateSeries(key: number, patch: Partial<Omit<SeriesDraft, "key">>) {
    setTimeSeries((current) => current.map((series) => series.key === key ? { ...series, ...patch } : series));
  }

  const mapping: CsvIngestMapping = useMemo(() => ({
    sourceSystem,
    runId,
    timestampColumn,
    assets: assets.map(({ externalId, name, type }) => ({ externalId, name, type })),
    timeSeries: timeSeries.map((series) => ({
      externalId: series.externalId,
      assetExternalId: series.assetExternalId,
      name: series.name,
      unit: series.unit,
      valueColumn: series.valueColumn,
      qualityColumn: series.qualityColumn,
    })),
  }), [assets, runId, sourceSystem, timeSeries, timestampColumn]);

  const validation = useMemo(() => {
    if (!table) return { bundle: null, error: "" };
    try {
      return { bundle: buildCsvIngestBundle(table, mapping), error: "" };
    } catch (cause) {
      return { bundle: null, error: errorMessage(cause, "The CSV mapping is invalid.") };
    }
  }, [mapping, table]);

  const mappingConfigured = sourceSystem.trim() !== ""
    && timestampColumn !== ""
    && assets.every((asset) => asset.externalId.trim() !== "" && asset.name.trim() !== "" && asset.type.trim() !== "")
    && timeSeries.every((series) => series.externalId.trim() !== ""
      && series.assetExternalId.trim() !== ""
      && series.name.trim() !== ""
      && series.valueColumn !== "");
  const pointCount = validation.bundle?.dataPoints?.length ?? 0;
  const assetOptions = assets.filter((asset) => asset.externalId.trim() !== "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validation.bundle) return;

    setStatus("submitting");
    setRequestError("");
    try {
      if (!context) throw new Error("Select a tenant and project before ingesting data.");
      const result = await ingestBundle(context, validation.bundle);
      const message = result.message
        || (result.runId ? `Ingest run ${result.runId} accepted` : "CSV ingest bundle accepted");
      const assetCount = validation.bundle.assets?.length ?? 0;
      const seriesCount = validation.bundle.timeSeries?.length ?? 0;
      setSuccessSummary(
        `${assetCount} ${assetCount === 1 ? "asset" : "assets"}, ${seriesCount} time series, and ${pointCount} ${pointCount === 1 ? "data point" : "data points"} were accepted for ${context.tenantId} / ${context.projectId}.`,
      );
      setStatus("success");
      onComplete(message);
    } catch (cause) {
      setStatus("error");
      setRequestError(errorMessage(cause, "The ingest request could not be completed."));
    }
  }

  if (status === "success") {
    return (
      <div className="success-panel csv-ingest-success">
        <CheckCircle2 size={44} />
        <h3>Bundle accepted</h3>
        <p>{successSummary}</p>
        <button ref={successActionRef} type="button" className="primary-button" onClick={onCancel}>Done</button>
      </div>
    );
  }

  return (
    <form className="csv-ingest-form" aria-busy={status === "submitting"} onSubmit={submit}>
      <fieldset className="csv-form-body" aria-label="CSV import configuration" disabled={status === "submitting"}>
        <section className="csv-file-panel" aria-labelledby="csv-file-heading">
        <div className="csv-section-heading">
          <div>
            <h3 id="csv-file-heading">Select source file</h3>
            <p>The file stays in this browser until you explicitly import it.</p>
          </div>
          <FileSpreadsheet size={20} aria-hidden="true" />
        </div>
        <div className="csv-file-controls">
          <label>
            CSV or TSV file
            <input
              ref={resolvedFileInputRef}
              aria-label="CSV or TSV file"
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              onChange={selectFile}
            />
          </label>
          <label>
            Delimiter
            <select aria-label="Delimiter" value={delimiter} onChange={selectDelimiter}>
              <option value=",">Comma</option>
              <option value={"\t"}>Tab</option>
            </select>
          </label>
        </div>
        {fileName ? <div className="csv-file-name"><FileSpreadsheet size={16} aria-hidden="true" /><span>{fileName}</span></div> : null}
        {fileError ? <div className="form-error" role="alert">{fileError}</div> : null}
        </section>

        {table ? (
          <>
          <section className="csv-preview" aria-labelledby="csv-preview-heading">
            <div className="csv-section-heading">
              <div>
                <h3 id="csv-preview-heading">File preview</h3>
                <p>{table.rows.length} {table.rows.length === 1 ? "row" : "rows"} parsed · showing up to 5</p>
              </div>
            </div>
            <div className="csv-preview-scroll">
              <table>
                <thead><tr>{table.headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
                <tbody>
                  {table.rows.slice(0, 5).map((row, rowIndex) => (
                    <tr key={rowIndex}>{table.headers.map((header) => <td key={header}>{row[header]}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="csv-mapping" aria-labelledby="csv-mapping-heading">
            <div className="csv-section-heading">
              <div>
                <h3 id="csv-mapping-heading">Map the bundle</h3>
                <p>Define static entities once, then map each value column to a time series.</p>
              </div>
            </div>

            <fieldset className="csv-mapping-group">
              <legend>Source</legend>
              <div className="form-grid csv-source-grid">
                <label>
                  Source system
                  <input required maxLength={100} value={sourceSystem} onChange={(event) => setSourceSystem(event.target.value)} />
                </label>
                <label>
                  Source run ID <span className="label-optional">Optional</span>
                  <input maxLength={255} value={runId} onChange={(event) => setRunId(event.target.value)} />
                </label>
                <label>
                  Timestamp column
                  <select aria-label="Timestamp column" required value={timestampColumn} onChange={(event) => setTimestampColumn(event.target.value)}>
                    <option value="">Select a column</option>
                    {table.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </label>
              </div>
            </fieldset>

            <fieldset className="csv-mapping-group">
              <legend>Assets</legend>
              <div className="csv-draft-list">
                {assets.map((asset, index) => (
                  <div className="csv-draft-row csv-asset-row" key={asset.key} role="group" aria-label={`Asset ${index + 1}`}>
                    <label>
                      External ID
                      <input aria-label={`Asset ${index + 1} external ID`} required maxLength={255} value={asset.externalId} onChange={(event) => updateAsset(asset.key, { externalId: event.target.value })} />
                    </label>
                    <label>
                      Name
                      <input aria-label={`Asset ${index + 1} name`} required maxLength={255} value={asset.name} onChange={(event) => updateAsset(asset.key, { name: event.target.value })} />
                    </label>
                    <label>
                      Type
                      <input aria-label={`Asset ${index + 1} type`} required maxLength={100} value={asset.type} onChange={(event) => updateAsset(asset.key, { type: event.target.value })} />
                    </label>
                    {assets.length > 1 ? (
                      <button type="button" className="csv-remove-button" aria-label={`Remove asset ${index + 1}`} onClick={() => setAssets((current) => current.filter((item) => item.key !== asset.key))}>
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              <button type="button" className="csv-add-button" onClick={() => setAssets((current) => [...current, blankAsset(nextDraftKey.current++)])}>
                <Plus size={16} aria-hidden="true" /> Add asset
              </button>
            </fieldset>

            <fieldset className="csv-mapping-group">
              <legend>Time series</legend>
              <div className="csv-draft-list">
                {timeSeries.map((series, index) => (
                  <div className="csv-draft-row csv-series-row" key={series.key} role="group" aria-label={`Time series ${index + 1}`}>
                    <label>
                      External ID
                      <input aria-label={`Time series ${index + 1} external ID`} required maxLength={255} value={series.externalId} onChange={(event) => updateSeries(series.key, { externalId: event.target.value })} />
                    </label>
                    <label>
                      Name
                      <input aria-label={`Time series ${index + 1} name`} required maxLength={255} value={series.name} onChange={(event) => updateSeries(series.key, { name: event.target.value })} />
                    </label>
                    <label>
                      Asset
                      <select aria-label={`Time series ${index + 1} asset`} required value={series.assetExternalId} onChange={(event) => updateSeries(series.key, { assetExternalId: event.target.value })}>
                        <option value="">Select an asset</option>
                        {assetOptions.map((asset) => <option key={asset.key} value={asset.externalId.trim()}>{asset.externalId.trim()}</option>)}
                      </select>
                    </label>
                    <label>
                      Value column
                      <select aria-label={`Time series ${index + 1} value column`} required value={series.valueColumn} onChange={(event) => updateSeries(series.key, { valueColumn: event.target.value })}>
                        <option value="">Select a column</option>
                        {table.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                      </select>
                    </label>
                    <label>
                      Quality column <span className="label-optional">Optional</span>
                      <select aria-label={`Time series ${index + 1} quality column`} value={series.qualityColumn} onChange={(event) => updateSeries(series.key, { qualityColumn: event.target.value })}>
                        <option value="">Default to good</option>
                        {table.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                      </select>
                    </label>
                    <label>
                      Unit <span className="label-optional">Optional</span>
                      <input aria-label={`Time series ${index + 1} unit`} maxLength={50} value={series.unit} onChange={(event) => updateSeries(series.key, { unit: event.target.value })} />
                    </label>
                    {timeSeries.length > 1 ? (
                      <button type="button" className="csv-remove-button" aria-label={`Remove time series ${index + 1}`} onClick={() => setTimeSeries((current) => current.filter((item) => item.key !== series.key))}>
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              <button type="button" className="csv-add-button" onClick={() => setTimeSeries((current) => [...current, blankSeries(nextDraftKey.current++)])}>
                <Plus size={16} aria-hidden="true" /> Add time series
              </button>
            </fieldset>
          </section>

          <div className={`csv-validation-summary${validation.bundle ? " is-valid" : " is-invalid"}`} role="status">
            <strong>{table.rows.length} {table.rows.length === 1 ? "row" : "rows"} · {pointCount} data points</strong>
            <span>{assets.length} {assets.length === 1 ? "asset" : "assets"} · {timeSeries.length} time series</span>
          </div>
          {validation.error && mappingConfigured ? <div className="form-error" role="alert">{validation.error}</div> : null}
          </>
        ) : null}
      </fieldset>

      {status === "error" && requestError ? <div className="form-error" role="alert">{requestError}</div> : null}
      <div className="modal-footer">
        <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary-button" disabled={!validation.bundle || status === "submitting"}>
          {status === "submitting" ? (
            <><LoaderCircle className="spin" size={17} aria-hidden="true" /> Importing…</>
          ) : (
            <><UploadCloud size={17} aria-hidden="true" /> Import {pointCount} data points</>
          )}
        </button>
      </div>
    </form>
  );
}
