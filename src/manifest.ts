import type { CourseSnapshot } from './types';

/** 生成 imsmanifest.xml 所需的一个 SCO 资源描述。 */
export interface ManifestResource {
  identifier: string;
  /** 入口的包内路径（href）。 */
  entryPath: string;
  /** 该 SCO 声明的包内文件集合（含入口）。 */
  files: string[];
}

export interface ManifestInput {
  snapshot: CourseSnapshot;
  /** 与 snapshot.modules 一一对应的组织条目 identifier。 */
  itemIdentifiers: string[];
  resources: ManifestResource[];
}

/** XML 文本内容转义。 */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** XML 属性值转义（双引号包裹）。 */
function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;');
}

/** 生成 SCORM 1.2 imsmanifest.xml 文本（UTF-8）。 */
export function buildManifest(input: ManifestInput): string {
  const { snapshot, itemIdentifiers, resources } = input;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<manifest identifier="MANIFEST-1" version="1.2"' +
      ' xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"' +
      ' xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd' +
      ' http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">'
  );
  lines.push('  <metadata>');
  lines.push('    <schema>ADL SCORM</schema>');
  lines.push('    <schemaversion>1.2</schemaversion>');
  lines.push('  </metadata>');
  lines.push('  <organizations default="ORG-1">');
  lines.push('    <organization identifier="ORG-1">');
  lines.push(`      <title>${escapeXmlText(snapshot.title)}</title>`);
  snapshot.modules.forEach((mod, index) => {
    const itemId = itemIdentifiers[index];
    const resource = resources[index];
    lines.push(
      `      <item identifier="${escapeXmlAttribute(itemId)}" identifierref="${escapeXmlAttribute(resource.identifier)}">`
    );
    lines.push(`        <title>${escapeXmlText(mod.title)}</title>`);
    lines.push('      </item>');
  });
  lines.push('    </organization>');
  lines.push('  </organizations>');
  lines.push('  <resources>');
  for (const resource of resources) {
    lines.push(
      `    <resource identifier="${escapeXmlAttribute(resource.identifier)}" type="webcontent" adlcp:scormtype="sco" href="${escapeXmlAttribute(resource.entryPath)}">`
    );
    for (const file of resource.files) {
      lines.push(`      <file href="${escapeXmlAttribute(file)}"/>`);
    }
    lines.push('    </resource>');
  }
  lines.push('  </resources>');
  lines.push('</manifest>');
  return lines.join('\n') + '\n';
}
