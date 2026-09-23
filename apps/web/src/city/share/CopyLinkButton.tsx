import { useEffect, useState } from 'react';

/** "Copiar link", with its own feedback. Used by the share panel and, when the scene cannot draw, by the top bar. */
export function CopyLinkButton({ url, className }: { url: string; className?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const id = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(id);
  }, [status]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(url);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <button type="button" className={className} onClick={() => void copy()} title={url}>
      {status === 'copied' ? 'Link copiado' : status === 'failed' ? `Copie: ${url}` : 'Copiar link'}
    </button>
  );
}
