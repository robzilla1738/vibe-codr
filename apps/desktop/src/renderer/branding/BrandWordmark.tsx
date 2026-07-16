import wordmarkUrl from "../assets/vibe-codr-wordmark.png";

export function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-wordmark${className ? ` ${className}` : ""}`}>
      <img className="brand-wordmark-image" src={wordmarkUrl} alt="Vibe Codr" />
    </span>
  );
}
