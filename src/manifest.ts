import type { CourseSnapshot, ScoDeclaration } from "./types.ts";

/**
 * Generates imsmanifest.xml for SCORM 1.2: one default organization
 * listing items in module order, one SCO resource per module entry whose
 * declared file set is exactly that entry's reachable closure.
 */
export function generateManifest(snapshot: CourseSnapshot, scos: ScoDeclaration[]): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<manifest identifier="MANIFEST-0001" version="1.2"' +
      ' xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"' +
      ' xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd' +
      ' http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">',
  );
  lines.push("  <metadata>");
  lines.push("    <schema>ADL SCORM</schema>");
  lines.push("    <schemaversion>1.2</schemaversion>");
  lines.push("  </metadata>");
  lines.push('  <organizations default="ORG-0001">');
  lines.push('    <organization identifier="ORG-0001">');
  lines.push(`      <title>${escapeXml(snapshot.title)}</title>`);
  for (let i = 0; i < scos.length; i++) {
    const sco = scos[i];
    const title = snapshot.modules[sco.moduleIndex].title;
    lines.push(
      `      <item identifier="${sco.itemIdentifier}" identifierref="${sco.resourceIdentifier}">`,
    );
    lines.push(`        <title>${escapeXml(title)}</title>`);
    lines.push("      </item>");
  }
  lines.push("    </organization>");
  lines.push("  </organizations>");
  lines.push("  <resources>");
  for (const sco of scos) {
    lines.push(
      `    <resource identifier="${sco.resourceIdentifier}" type="webcontent"` +
        ` adlcp:scormtype="sco" href="${escapeXml(sco.entryPackagePath)}">`,
    );
    for (const file of sco.files) {
      lines.push(`      <file href="${escapeXml(file)}"/>`);
    }
    lines.push("    </resource>");
  }
  lines.push("  </resources>");
  lines.push("</manifest>");
  return lines.join("\n") + "\n";
}

/** Escapes a string for XML text/attribute content. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
