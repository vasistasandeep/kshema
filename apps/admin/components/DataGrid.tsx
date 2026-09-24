"use client";

/**
 * A small, accessible data grid for the console's read views.
 *
 * The design calls for `@tanstack/react-table` grids; that dependency is not
 * available in this workspace, so the console ships a lightweight in-house grid
 * with the same ergonomics (typed column defs + row rendering) and semantic
 * `<table>` markup for accessibility. Swapping in `@tanstack/react-table` later
 * is a drop-in replacement behind this component's props.
 */
import type { ReactNode } from "react";

export interface Column<Row> {
  /** Stable key for React and the column header id. */
  readonly key: string;
  /** Header label. */
  readonly header: string;
  /** Cell renderer for a row. */
  readonly render: (row: Row) => ReactNode;
  /** Optional cell alignment. */
  readonly align?: "left" | "right";
}

export interface DataGridProps<Row> {
  readonly columns: ReadonlyArray<Column<Row>>;
  readonly rows: ReadonlyArray<Row>;
  readonly rowKey: (row: Row, index: number) => string;
  /** Optional per-row emphasis class (e.g. dispatch-failure alarm — R21.11). */
  readonly rowClassName?: (row: Row) => string | undefined;
  /** Message shown when there are no rows. */
  readonly emptyLabel?: string;
}

export function DataGrid<Row>({
  columns,
  rows,
  rowKey,
  rowClassName,
  emptyLabel = "Nothing to show right now.",
}: DataGridProps<Row>): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-xl border border-typography/10 bg-white/40">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-typography/10 text-left text-typography/60">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`px-4 py-3 font-medium ${
                  col.align === "right" ? "text-right" : "text-left"
                }`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-6 text-center text-typography/50"
              >
                {emptyLabel}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                className={`border-b border-typography/5 last:border-0 ${
                  rowClassName?.(row) ?? ""
                }`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-4 py-3 ${
                      col.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
