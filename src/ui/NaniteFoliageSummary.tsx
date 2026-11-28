type MaterialGroup = { key: string; name: string; role: string; ownerVariant: string };
type Variant = { name: string; materials: Array<{ key: string }> };

export function NaniteFoliageSummary({ manifest, english = false }: { manifest?: Record<string, unknown>; english?: boolean }) {
  const groups = (Array.isArray(manifest?.groups) ? manifest.groups : []) as MaterialGroup[];
  const variants = (Array.isArray(manifest?.variants) ? manifest.variants : []) as Variant[];
  if (!groups.length) return null;
  return <table className="nanite-foliage-groups">
    <thead><tr><th>{english ? "Texture group" : "纹理组"}</th><th>{english ? "Parent" : "父材质"}</th><th>{english ? "Variants" : "使用变体"}</th></tr></thead>
    <tbody>{groups.map(group => <tr key={group.key}>
      <td>{group.ownerVariant} / {group.name}</td><td>{group.role}</td>
      <td>{variants.filter(variant => variant.materials.some(material => material.key === group.key)).map(variant => variant.name).join(", ")}</td>
    </tr>)}</tbody>
  </table>;
}
