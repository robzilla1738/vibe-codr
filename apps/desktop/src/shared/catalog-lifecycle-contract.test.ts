import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("catalog presentation lifecycle", () => {
  const source = readFileSync(join(process.cwd(), "src/renderer/App.tsx"), "utf8");
  const modalSource = readFileSync(
    join(process.cwd(), "src/renderer/pickers/CatalogModal.tsx"),
    "utf8",
  );

  it("allows only the latest async request to update the picker", () => {
    const presenterStart = source.indexOf("const presentCatalog = useCallback");
    const presenterEnd = source.indexOf("const retryCatalog = useCallback", presenterStart);
    const presenter = source.slice(presenterStart, presenterEnd);

    expect(source).toContain("const catalogPresentationGate = useRef(new RequestGate())");
    expect(presenter).toContain("const request = catalogPresentationGate.current.begin()");
    expect(presenter).toContain("!isCurrent()");
    expect(presenter).not.toContain('current?.status === "loading" ? null : current');
  });

  it("invalidates pending work when the catalog is dismissed", () => {
    const dismissStart = source.indexOf("const dismissCatalog = useCallback");
    const dismissEnd = source.indexOf("const invalidateCatalogs = useCallback", dismissStart);
    const dismiss = source.slice(dismissStart, dismissEnd);

    expect(dismiss).toContain("catalogPresentationGate.current.invalidate()");
    expect(dismiss).toContain("pickerRetryRef.current = null");
    expect(source).toContain("onClose={() => {\n                    dismissCatalog();");
  });

  it("keeps non-actionable MCP status rows visible and filterable", () => {
    expect(modalSource).toContain('className="catalog-row is-static" role="listitem"');
    const filterStart = modalSource.indexOf("const filteredOptions = useMemo");
    const filterEnd = modalSource.indexOf("const limited = useMemo", filterStart);
    expect(modalSource.slice(filterStart, filterEnd)).not.toContain("if (!isActionable(opt))");
  });
});
