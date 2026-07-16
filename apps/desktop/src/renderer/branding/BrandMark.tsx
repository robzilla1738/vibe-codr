import markUrl from "../assets/vibe-codr-sidebar.png";

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-mark${className ? ` ${className}` : ""}`}>
      <img className="brand-mark-image" src={markUrl} alt="Vibe Codr" />
    </span>
  );
}
