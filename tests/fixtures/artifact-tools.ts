import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function artifactFixtureText(lines = 700): string {
  return Array.from({ length: lines }, (_, index) => index === 419 ? "ERROR artifact benchmark critical diagnostic" : `fixture-line-${index + 1} ${"x".repeat(48)}`).join("\n");
}

export default function artifactTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "artifact_fixture",
    label: "Artifact benchmark fixture",
    description: "Return deterministic large text for the local Artifact Store benchmark.",
    parameters: Type.Object({ lines: Type.Optional(Type.Integer({ minimum: 500, maximum: 1000 })), fail: Type.Optional(Type.Boolean()) }),
    async execute(_id, parameters) {
      const text = artifactFixtureText(parameters.lines ?? 700);
      if (parameters.fail === true) throw new Error(text);
      return { content: [{ type: "text", text }], details: { fixture: true, sourceChars: text.length } };
    },
  });
}
