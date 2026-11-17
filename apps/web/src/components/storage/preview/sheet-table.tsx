import { memo } from "react";

export const SheetTable = memo(function SheetTable(props: { rows: string[][] }) {
  const [head = [], ...body] = props.rows;
  const columns = Math.max(head.length, ...body.slice(0, 50).map((row) => row.length));
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <table className="min-w-full border-separate border-spacing-0 text-sm tabular-nums">
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, i) => (
              <th
                key={i}
                scope="col"
                className="sticky top-0 border-b bg-background px-3 py-2 text-start text-xs font-normal whitespace-nowrap text-muted-foreground first:ps-5"
              >
                {head[i] ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {Array.from({ length: columns }, (_, c) => (
                <td
                  key={c}
                  className="max-w-64 truncate border-b px-3 py-2 whitespace-nowrap text-foreground first:ps-5"
                >
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
