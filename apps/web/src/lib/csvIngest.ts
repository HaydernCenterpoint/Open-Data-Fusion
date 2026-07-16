export type CsvDelimiter = "," | "\t";

export interface DelimitedTable {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export class CsvIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvIngestError";
  }
}

type ParserState = "unquoted" | "quoted" | "after-quote";

interface ParsedRecord {
  cells: string[];
  sourceRow: number;
}

function isRecordEnding(character: string): boolean {
  return character === "\r" || character === "\n";
}

export function parseDelimitedText(input: string, delimiter: CsvDelimiter): DelimitedTable {
  if (delimiter !== "," && delimiter !== "\t") {
    throw new CsvIngestError("delimiter must be a comma or tab");
  }

  const records: ParsedRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let state: ParserState = "unquoted";
  let sourceRow = 1;
  let recordSourceRow = 1;
  let recordHasContent = false;
  let index = input.charCodeAt(0) === 0xfeff ? 1 : 0;

  const finishRecord = () => {
    cells.push(cell);
    records.push({ cells, sourceRow: recordSourceRow });
    cells = [];
    cell = "";
    recordHasContent = false;
  };

  const advancePastRecordEnding = (character: string, startsNextRecord = true) => {
    if (character === "\r" && input[index + 1] === "\n") index += 1;
    sourceRow += 1;
    if (startsNextRecord) recordSourceRow = sourceRow;
  };

  for (; index < input.length; index += 1) {
    const character = input[index];

    if (state === "quoted") {
      if (character === "\"") {
        if (input[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          state = "after-quote";
        }
      } else if (isRecordEnding(character)) {
        cell += character;
        advancePastRecordEnding(character, false);
        if (character === "\r" && input[index] === "\n") cell += "\n";
      } else {
        cell += character;
      }
      continue;
    }

    if (state === "after-quote") {
      if (character === delimiter) {
        cells.push(cell);
        cell = "";
        state = "unquoted";
        continue;
      }
      if (isRecordEnding(character)) {
        finishRecord();
        advancePastRecordEnding(character);
        state = "unquoted";
        continue;
      }
      throw new CsvIngestError(`row ${sourceRow}: invalid character after closing quote`);
    }

    if (character === delimiter) {
      cells.push(cell);
      cell = "";
      recordHasContent = true;
      continue;
    }

    if (isRecordEnding(character)) {
      finishRecord();
      advancePastRecordEnding(character);
      continue;
    }

    if (character === "\"") {
      if (cell !== "") {
        throw new CsvIngestError(`row ${sourceRow}: quote must begin a field`);
      }
      recordHasContent = true;
      state = "quoted";
      continue;
    }

    cell += character;
    recordHasContent = true;
  }

  if (state === "quoted") {
    throw new CsvIngestError(`row ${recordSourceRow}: unclosed quoted field`);
  }

  if (recordHasContent || records.length === 0) finishRecord();

  const [headerRecord, ...dataRecords] = records;
  const headers = headerRecord.cells;
  const headerNames = new Set<string>();

  headers.forEach((header, column) => {
    if (header === "") {
      throw new CsvIngestError(`row ${headerRecord.sourceRow}: header ${column + 1} is empty`);
    }
    if (headerNames.has(header)) {
      throw new CsvIngestError(`row ${headerRecord.sourceRow}: duplicate header '${header}'`);
    }
    headerNames.add(header);
  });

  dataRecords.forEach((record) => {
    if (record.cells.length !== headers.length) {
      throw new CsvIngestError(
        `row ${record.sourceRow} has ${record.cells.length} cells; expected ${headers.length}`,
      );
    }
  });

  return {
    headers,
    rows: dataRecords.map((record) => Object.fromEntries(record.cells.map((value, column) => [headers[column], value]))),
  };
}
