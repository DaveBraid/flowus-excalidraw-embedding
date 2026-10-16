/** 保存队列冻结操作ID与快照；未知结果先确认，同次重试不得携带后续编辑。 */
export class SaveMachine {
  constructor({ revision, persist, confirm, onState = () => {} }) {
    Object.assign(this, { revision, persist, confirm, onState, latest: null, savedKey: null, inFlight: null, metadataPending: null, queued: false, blocked: false, disposed: false, error: null, operation: null, uncertain: false });
  }
  capture(scene) {
    const key = JSON.stringify(scene); if (this.latest?.key === key) return;
    this.latest = { scene, key }; if (this.savedKey === null) this.savedKey = key;
    if (!this.operation && this.error && !this.blocked && key !== this.savedKey) this.error = null;
    this.notify();
  }
  get dirty() { return this.latest !== null && this.latest.key !== this.savedKey; }
  notify() {
    if (!this.disposed) this.onState({ status: this.blocked ? 'conflict' : this.uncertain ? 'confirming' : (this.inFlight || this.metadataPending) ? 'saving' : this.error ? 'error' : this.dirty ? 'dirty' : 'saved', dirty: this.dirty, error: this.error });
  }
  /** 查询已提交凭证；查询不确定时保留原操作，绝不把未知当作失败并覆盖。 */
  async execute(op) {
    let result;
    try {
      if (this.uncertain && this.confirm) {
        const state = await this.confirm(op.payload.operationId);
        if (state.status === 'committed') result = state.canvas;
      }
      if (!result) result = await this.persist(op.payload);
    } catch (error) {
      if ((!error.status || error.status >= 500) && this.confirm) {
        this.uncertain = true; this.error = '保存结果待确认，当前修改已保留'; this.notify();
        try { const state = await this.confirm(op.payload.operationId); if (state.status === 'committed') result = state.canvas; } catch { /* 网络仍不可用，保留冻结操作供下次确认。 */ }
      }
      if (!result) {
        this.error = error.message; this.blocked = [409, 410].includes(error.status) && error.code !== 'ASSET_MISSING';
        if (error.status && error.status < 500 && !this.uncertain) this.operation = null; // 明确拒绝的请求可在修正内容后重新提交。
        return false;
      }
    }
    this.revision = result.revision; this.uncertain = false; this.error = null; this.operation = null;
    if (op.snapshot) this.savedKey = op.snapshot.key;
    if (result.superseded) { this.blocked = true; this.error = '本次保存已成功，但已有后续版本，请重新读取'; }
    return result;
  }
  save() {
    if (this.blocked || this.disposed) return Promise.resolve(false);
    if (this.metadataPending) return this.metadataPending;
    if (this.inFlight) { this.queued = true; return this.inFlight; }
    if (!this.dirty && !this.operation) return Promise.resolve(true);
    this.error = null;
    const work = async () => {
      do {
        this.queued = false;
        const snapshot = this.latest;
        this.operation ||= { snapshot, payload: { operationId: crypto.randomUUID(), revision: this.revision, scene: snapshot.scene } };
        const old = this.operation;
        if (!await this.execute(old) || this.blocked) return false;
        if (old.snapshot && snapshot && old.snapshot.key !== snapshot.key) this.queued = true;
      } while (!this.disposed && !this.metadataPending && this.queued && this.dirty);
      return true;
    };
    this.inFlight = Promise.resolve().then(work).finally(() => { this.inFlight = null; this.notify(); }); this.notify(); return this.inFlight;
  }
  rename(title) {
    if (this.blocked || this.disposed) return Promise.resolve(false);
    if (this.metadataPending) return this.metadataPending;
    const previous = this.inFlight; this.queued = false;
    const work = async () => {
      if (previous) await previous;
      if (this.blocked || this.disposed) return false;
      if (this.operation) { const op = this.operation; const result = await this.execute(op); if (!result || this.blocked) return false; if (op.payload.title === title) return result; }
      this.operation = { payload: { operationId: crypto.randomUUID(), revision: this.revision, title } };
      return this.execute(this.operation);
    };
    this.metadataPending = Promise.resolve().then(work).finally(() => { this.metadataPending = null; this.notify(); }); this.notify(); return this.metadataPending;
  }
  dispose() { this.disposed = true; this.queued = false; }
}

/** 只保留有效场景内容；忽略选择、视角、工具和文件访问时间。 */
export function contentScene(elements, appState = {}, files = {}) {
  const active = elements.filter(element => !element.isDeleted);
  const usedFiles = new Set(active.filter(element => element.type === 'image' && element.fileId).map(element => element.fileId));
  const binary = {};
  for (const id of [...usedFiles].sort()) {
    if (files[id]) {
      const { lastRetrieved, ...file } = files[id]; // 读取缓存的时间不属于图片内容。
      binary[id] = file;
    }
  }
  return { elements: active, appState: { viewBackgroundColor: appState.viewBackgroundColor || '#ffffff' }, files: binary };
}
