import { describe, expect, it } from "vitest";

import { CsvIngestError, parseDelimitedText } from "./csvIngest";

describe("parseDelimitedText", () => {
  it("parses comma-delimited headers and a data row", () => {
    expect(parseDelimitedText("timestamp,value\n2026-07-16T12:00:00Z,42", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [{ timestamp: "2026-07-16T12:00:00Z", value: "42" }],
    });
  });

  it("rejects delimiters other than comma and tab", () => {
    const parseUnchecked = parseDelimitedText as (input: string, delimiter: string) => unknown;

    expect(() => parseUnchecked("timestamp;value\n2026-07-16;42", ";")).toThrow(
      CsvIngestError,
    );
  });

  it("preserves delimiters inside quoted cells", () => {
    expect(parseDelimitedText("timestamp,comment\n2026-07-16,\"rain, then sun\"", ",")).toEqual({
      headers: ["timestamp", "comment"],
      rows: [{ timestamp: "2026-07-16", comment: "rain, then sun" }],
    });
  });

  it("decodes doubled quotes inside quoted cells", () => {
    expect(parseDelimitedText("message\n\"The device said \"\"ready\"\"\"", ",")).toEqual({
      headers: ["message"],
      rows: [{ message: 'The device said "ready"' }],
    });
  });

  it("rejects a quote that does not begin a field", () => {
    expect(() => parseDelimitedText("timestamp,value\n2026-07-16,bad\"quote", ",")).toThrow(
      "row 2: quote must begin a field",
    );
  });

  it("rejects characters after a closing quote", () => {
    expect(() => parseDelimitedText("timestamp,value\n\"2026-07-16\"oops,42", ",")).toThrow(
      "row 2: invalid character after closing quote",
    );
  });

  it("rejects an unclosed quoted field with its source row", () => {
    expect(() => parseDelimitedText("timestamp,value\n2026-07-16,\"unfinished", ",")).toThrow(
      "row 2: unclosed quoted field",
    );
  });

  it("keeps the opening source row for an unclosed multiline quoted field", () => {
    expect(() => parseDelimitedText("timestamp,value\n\"first line\nsecond line", ",")).toThrow(
      "row 2: unclosed quoted field",
    );
  });

  it("rejects empty headers", () => {
    expect(() => parseDelimitedText(",value\n2026-07-16,42", ",")).toThrow("row 1: header 1 is empty");
  });

  it("rejects duplicate headers", () => {
    expect(() => parseDelimitedText("timestamp,timestamp\n2026-07-16,42", ",")).toThrow(
      "row 1: duplicate header 'timestamp'",
    );
  });

  it("rejects non-empty uneven rows with source-row context", () => {
    expect(() => parseDelimitedText("timestamp,value\n2026-07-16", ",")).toThrow(
      "row 2 has 1 cells; expected 2",
    );
  });

  it("ignores an entirely trailing empty physical record", () => {
    expect(parseDelimitedText("timestamp,value\n2026-07-16,42\n", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [{ timestamp: "2026-07-16", value: "42" }],
    });
  });

  it("retains valid empty cells before a trailing newline", () => {
    expect(parseDelimitedText("timestamp,value\n,\n", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [{ timestamp: "", value: "" }],
    });
  });

  it("parses tab-delimited input with quoted tabs", () => {
    expect(parseDelimitedText("timestamp\tcomment\n2026-07-16\t\"rain\tthen sun\"", "\t")).toEqual({
      headers: ["timestamp", "comment"],
      rows: [{ timestamp: "2026-07-16", comment: "rain\tthen sun" }],
    });
  });

  it("strips a leading UTF-8 byte-order mark", () => {
    expect(parseDelimitedText("\uFEFFtimestamp,value\n2026-07-16,42", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [{ timestamp: "2026-07-16", value: "42" }],
    });
  });

  it("recognizes CRLF, CR, and LF record endings", () => {
    expect(parseDelimitedText("timestamp,value\r2026-07-16,42\r\n2026-07-17,43\n", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [
        { timestamp: "2026-07-16", value: "42" },
        { timestamp: "2026-07-17", value: "43" },
      ],
    });
  });
});
