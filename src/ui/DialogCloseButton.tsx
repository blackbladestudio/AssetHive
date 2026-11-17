export function DialogCloseButton({ onClick, label, disabled = false }: {
  onClick: () => void; label: string; disabled?: boolean;
}) {
  return <button type="button" className="dialog-close-button" onClick={onClick} disabled={disabled} title={label} aria-label={label}>
    <span aria-hidden="true">×</span>
  </button>;
}
