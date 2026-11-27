import { useState } from 'react';
import { characterSendGuidance } from '../../shared/characterSendGuidance.mjs';

/** Keep the original diagnostic available; never turn a failed operation into success. */
export function CharacterSendError({ message, t }: {
  message: string;
  t: (zh: string, en: string) => string;
}) {
  const [copyState, setCopyState] = useState('');
  const help = characterSendGuidance(message, t);
  async function copy() {
    try {
      await window.arkhive.copyText(message);
      setCopyState(t('已复制', 'Copied'));
    } catch {
      setCopyState(t('复制失败，请展开下方详情手动复制。', 'Copy failed. Expand the details below and copy them manually.'));
    }
  }
  return <section className="suit-export-error" role="alert">
    <strong>{help.title}</strong>
    <p>{help.next}</p>
    <button className="browse-btn" onClick={() => void copy()}>{t('复制诊断信息', 'Copy diagnostic details')}</button>
    {copyState && <small role="status">{copyState}</small>}
    <details><summary>{t('查看详细原因', 'Show details')}</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message}</p></details>
  </section>;
}
