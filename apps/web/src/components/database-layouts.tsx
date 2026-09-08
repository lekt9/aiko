import { useState } from "react";
import type { DatabaseColumn, DatabaseRow } from "../lib/databases";
import { boardGroups, cellText, chartBars, monthDays, presentationError, recordTitle, utcDay, type DatabasePresentation } from "../lib/database-layouts";

interface LayoutProps {
  rows: DatabaseRow[];
  columns: DatabaseColumn[];
  presentation: DatabasePresentation;
  open?: (id: string) => void;
}
function RecordCard({ row, columns, presentation, open }: Omit<LayoutProps, "rows"> & { row: DatabaseRow }) {
  const title = recordTitle(row, columns, presentation);
  const fields = columns.filter(column => column.id !== presentation.titleField).slice(0, 3);
  return <article className="db-record-card">
    {open ? <button className="db-record-title" aria-label={`Open record ${title}`} onClick={() => open(row.id)}>{title}</button> : <strong>{title}</strong>}
    <dl>{fields.map(column => <div key={column.id}><dt>{column.name}</dt><dd>{cellText(row.cells[column.id])}{row.cells[column.id]?.freshness === "stale" && <small className="db-stale"> Stale</small>}</dd></div>)}</dl>
  </article>;
}
function RecordList({ rows, ...props }: LayoutProps) {
  return <ul className="db-record-list">{rows.map(row => <li key={row.id}><RecordCard row={row} {...props} /></li>)}</ul>;
}
function Board({ rows, columns, presentation, open }: LayoutProps) {
  const column = columns.find(column => column.id === presentation.groupField)!;
  return <section aria-label={`Board grouped by ${column.name}`}>
    <p className="db-layout-caption">Grouped by {column.name} · Counts include the loaded records.</p>
    <div className="db-board" tabIndex={0} aria-label="Scrollable board">
      {boardGroups(rows, column).map(group => <section className="db-board-column" key={group.key} aria-label={`${group.label}: ${group.rows.length} records`}>
        <h3>{group.label}<span>{group.rows.length}</span></h3>
        <RecordList rows={group.rows} columns={columns} presentation={presentation} open={open} />
        {!group.rows.length && <p className="db-muted">No records</p>}
      </section>)}
    </div>
  </section>;
}
function Calendar({ rows, columns, presentation, open }: LayoutProps) {
  const field = presentation.dateField!;
  const dated = rows.map(row => ({ row, day: utcDay(row, field) }));
  const first = dated.flatMap(item => item.day ? [item.day] : []).sort()[0];
  const [month, setMonth] = useState(() => (first ?? new Date().toISOString()).slice(0, 7));
  const date = new Date(`${month}-01T00:00:00Z`);
  const changeMonth = (change: number) => { const next = new Date(date); next.setUTCMonth(next.getUTCMonth() + change); setMonth(next.toISOString().slice(0, 7)); };
  const days = monthDays(month);
  const undated = dated.filter(item => !item.day).map(item => item.row);
  const outside = dated.filter(item => item.day && !item.day.startsWith(month)).length;
  return <section aria-label="Calendar view">
    <div className="db-calendar-heading">
      <button aria-label="Previous month" disabled={month === "0000-01"} onClick={() => changeMonth(-1)}>←</button>
      <h3>{new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(date)}</h3>
      <button aria-label="Next month" disabled={month === "9999-12"} onClick={() => changeMonth(1)}>→</button>
    </div>
    <p className="db-layout-caption">{columns.find(column => column.id === field)!.name} · Dates shown in UTC · {outside} loaded records outside this month.</p>
    <div className="db-calendar-scroll" tabIndex={0} aria-label="Scrollable calendar">
      <div className="db-calendar-week" aria-hidden="true">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => <span key={day}>{day}</span>)}</div>
      <ol className="db-calendar-days">{days.map((day, index) => <li key={day ?? `blank-${index}`} className={day ? "" : "db-calendar-blank"}>
        {day && <><time dateTime={day}>{Number(day.slice(-2))}<span className="db-visually-hidden"> {month} UTC</span></time>
          {dated.filter(item => item.day === day).map(({ row }) => <RecordCard key={row.id} row={row} columns={columns} presentation={presentation} open={open} />)}
        </>}
      </li>)}</ol>
    </div>
    {undated.length > 0 && <div className="db-undated"><h3>Without an available date · {undated.length}</h3><RecordList rows={undated} columns={columns} presentation={presentation} open={open} /></div>}
  </section>;
}
function Chart({ rows, columns, presentation, open }: LayoutProps) {
  const field = presentation.valueField!, column = columns.find(column => column.id === field)!;
  const { bars, zero } = chartBars(rows, field);
  return <figure className="db-chart" aria-label={`${column.name} by record`}>
    <figcaption>{column.name} by record <span>Each bar represents one loaded record. Value labels are exact.</span></figcaption>
    <ol>{rows.map((row, index) => {
      const bar = bars[index], title = recordTitle(row, columns, presentation);
      return <li key={row.id}>
        <div className="db-chart-label">{open ? <button aria-label={`Open record ${title}`} onClick={() => open(row.id)}>{title}</button> : <strong>{title}</strong>}<span>{cellText(row.cells[field])}{row.cells[field]?.freshness === "stale" && <small className="db-stale"> Stale</small>}</span></div>
        {bar ? <div className="db-chart-track" aria-hidden="true"><i className="db-chart-zero" style={{ left: `${zero}%` }} /><span className={bar.negative ? "db-chart-negative" : ""} style={{ left: `${bar.start}%`, width: `${bar.width}%` }} /></div> : <p className="db-muted">No bar: this value is not an available number.</p>}
      </li>;
    })}</ol>
  </figure>;
}
export function DatabaseLayout(props: LayoutProps) {
  const error = presentationError(props.presentation, props.columns);
  if (error) return <p className="db-empty" role="status">{error}</p>;
  switch (props.presentation.layout) {
    case "list": return <RecordList {...props} />;
    case "board": return <Board {...props} />;
    case "calendar": return <Calendar key={props.presentation.dateField} {...props} />;
    case "chart": return <Chart {...props} />;
    default: return null;
  }
}
