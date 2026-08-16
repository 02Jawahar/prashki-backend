import type { Response } from 'express'

/**
 * CSV export (FR-08.6, FR-20.4).
 *
 * Written by hand rather than pulled in as a dependency, because the whole
 * problem is one escaping rule and one injection rule, and both are worth
 * being able to read.
 */

/**
 * Escapes a value for a CSV cell.
 *
 * Two separate concerns:
 *
 *   Quoting — a value containing a comma, quote or newline must be wrapped and
 *   its quotes doubled, or the row silently gains columns.
 *
 *   Formula injection — a cell beginning with = + - @ or a control character
 *   is executed by Excel and Sheets when the file is opened. A customer whose
 *   name is `=HYPERLINK(...)` would otherwise become a live formula in
 *   whatever machine opens the export. Prefixing with an apostrophe makes the
 *   spreadsheet treat it as text; the value is unchanged for any other reader.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return ''

  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)

  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`

  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export interface CsvColumn<T> {
  header: string
  value: (row: T) => unknown
}

export function toCsv<T>(rows: T[], columns: Array<CsvColumn<T>>): string {
  const lines = [columns.map((column) => cell(column.header)).join(',')]

  for (const row of rows) {
    lines.push(columns.map((column) => cell(column.value(row))).join(','))
  }

  // CRLF, because that is what Excel expects and every other reader tolerates.
  return `${lines.join('\r\n')}\r\n`
}

/**
 * Sends a CSV as a download.
 *
 * The generation time goes in the filename because an export is a snapshot,
 * and a file called `orders.csv` on someone's desktop is undateable otherwise
 * (FR-20.4: "clear generation time and timezone").
 */
export function sendCsv(res: Response, filename: string, csv: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  res.setHeader('content-type', 'text/csv; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="${filename}-${stamp}Z.csv"`)
  // A byte-order mark, so Excel reads UTF-8 rather than guessing at the ₹ sign.
  res.send(`﻿${csv}`)
}
