import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert } from 'lucide-react';

/** 页面内确认框；输入操作说明与回调，输出顶层模态层，不依赖iframe的allow-modals权限。 */
export function ConfirmDialog({ title, description, confirmLabel, destructive = false, busy, error, onConfirm, onCancel }) {
  const dialog = useRef(null); const cancel = useRef(null); const id = useId();
  useEffect(() => {
    const node = dialog.current;
    node.showModal(); cancel.current?.focus(); // 默认聚焦取消，避免回车误触删除。
    return () => node.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="manage-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!busy) onConfirm(); }} aria-busy={busy}>
      <div className={`manage-dialog-icon${destructive ? ' danger' : ''}`}><TriangleAlert size={22} strokeWidth={1.75} aria-hidden="true" /></div>
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-description`}>{description}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button ref={cancel} type="button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className={destructive ? 'danger-button' : 'primary'} disabled={busy}>{busy ? '正在处理…' : confirmLabel}</button></div>
    </form>
  </dialog>, document.body);
}
