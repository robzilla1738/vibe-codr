import {
  type ComponentProps,
  type ComponentType,
  createElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  KeyValueTextArea,
  SettingField,
  TextInput,
  ToggleSwitch,
} from "./FormControls";

type TestSettingFieldProps = Omit<ComponentProps<typeof SettingField>, "children"> & {
  children?: ReactNode;
};
const TestSettingField = SettingField as ComponentType<TestSettingFieldProps>;

describe("Settings form accessibility", () => {
  it("associates a field label and description with its input", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TestSettingField,
        { label: "API key", description: "Used for provider requests." },
        createElement(TextInput, {
          value: "",
          onChange: () => undefined,
          type: "password",
        }),
      ),
    );

    const labelId = markup.match(/<span id="([^"]+)" class="setting-field-name">/)?.[1];
    const descriptionId = markup.match(/<p id="([^"]+)" class="setting-field-desc">/)?.[1];
    expect(labelId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    expect(markup).toContain(`aria-labelledby="${labelId}"`);
    expect(markup).toContain(`aria-describedby="${descriptionId}"`);
  });

  it("labels button switches through the same field contract", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TestSettingField,
        { label: "Enable MCP" },
        createElement(ToggleSwitch, { checked: false, onChange: () => undefined }),
      ),
    );

    const labelId = markup.match(/<span id="([^"]+)" class="setting-field-name">/)?.[1];
    expect(labelId).toBeTruthy();
    expect(markup).toContain('role="switch"');
    expect(markup).toContain(`aria-labelledby="${labelId}"`);
  });

  it("labels key/value editors through the same field contract", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TestSettingField,
        { label: "Headers" },
        createElement(KeyValueTextArea, {
          value: { Authorization: "Bearer token" },
          onChange: () => undefined,
          separator: ":",
          resetKey: "headers",
        }),
      ),
    );

    expect(markup).toContain("aria-labelledby=");
    expect(markup).toContain("Authorization: Bearer token");
  });
});
