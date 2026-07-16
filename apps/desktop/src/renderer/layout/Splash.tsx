import { BrandWordmark } from "../branding/BrandWordmark";

export function Splash() {
  return (
    <section className="splash" aria-labelledby="splash-brand-title">
      <div className="splash-inner">
        <h1 id="splash-brand-title" className="sr-only">
          Vibe Codr
        </h1>
        <div className="splash-brand" aria-hidden>
          <BrandWordmark className="splash-wordmark" />
        </div>

        <p className="splash-tagline">Ask Vibe Codr to plan, build, or review this project.</p>
      </div>
    </section>
  );
}
