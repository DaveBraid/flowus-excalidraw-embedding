import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasRoute, isMissingCanvas } from './canvas-route.mjs';

test('固定URL沿用后端ASCII标识规则，正常编码只解码一次', () => {
  for (const path of ['/c/canvas-name', '/c/canvas_name/', '/c/%63anvas-name', '/c/api']) assert.equal(canvasRoute(path).kind, 'canvas');
  assert.equal(canvasRoute('/c/%63anvas-name').slug, 'canvas-name');
  for (const path of ['/c/Canvas', '/c/a%20b', '/c/a%2Fb', '/c/%252F', '/c/%', '/c/中文', '/c/-a', '/c/', '/c/a/b', `/c/${'a'.repeat(81)}`]) assert.equal(canvasRoute(path).kind, 'invalid', path);
});

test('缺失确认必须是合法slug、404和明确的CANVAS_NOT_FOUND', () => {
  assert.equal(isMissingCanvas({ status: 404, code: 'CANVAS_NOT_FOUND' }, 'new-canvas'), true);
  for (const status of [400, 401, 403, 409, 500]) assert.equal(isMissingCanvas({ status, code: 'CANVAS_NOT_FOUND' }, 'new-canvas'), false);
  assert.equal(isMissingCanvas({ status: 404 }, 'new-canvas'), false);
  assert.equal(isMissingCanvas({ status: 404, code: 'CANVAS_NOT_FOUND' }, 'Bad Slug'), false);
  assert.equal(isMissingCanvas(new Error('网络失败'), 'new-canvas'), false);
});
