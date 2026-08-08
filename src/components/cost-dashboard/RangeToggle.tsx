type Range = 7 | 30 | 90;
export function RangeToggle({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const opts: Array<{ label: string; value: Range }> = [
    { label: "7d", value: 7 }, { label: "30d", value: 30 }, { label: "90d", value: 90 },
  ];
  return (
    <div className="range-toggle">
      {opts.map(o => (
        <button key={o.value} className={`ghost ${value === o.value ? "active" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
