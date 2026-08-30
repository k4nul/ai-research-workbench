import type { ReactNode } from "react";

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  align?: "left" | "center" | "right";
  className?: string;
  headerClassName?: string;
}

interface DataTableProps<Row> {
  caption: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  emptyState?: ReactNode;
  compact?: boolean;
  rowClassName?: (row: Row) => string | undefined;
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  emptyState,
  compact = false,
  rowClassName,
}: DataTableProps<Row>) {
  return (
    <div
      aria-label={`${caption} table; scroll horizontally when needed`}
      className="data-table-region"
      tabIndex={0}
    >
      <table className="data-table" data-compact={compact || undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                className={column.headerClassName}
                data-align={column.align ?? "left"}
                key={column.id}
                scope="col"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length > 0 ? (
            rows.map((row) => (
              <tr className={rowClassName?.(row)} key={getRowKey(row)}>
                {columns.map((column) => (
                  <td
                    className={column.className}
                    data-align={column.align ?? "left"}
                    key={column.id}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td className="data-table__empty" colSpan={Math.max(columns.length, 1)}>
                {emptyState ?? "No records match the current view."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
