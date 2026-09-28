import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { filterUpstreamCookies, makeTlsPinChecker } from '../lib/index.js'

test('filterUpstreamCookies keeps only bmcweb cookie names', () => {
  const header = '__Host-dsh_auth_session=secret; SESSION=abc-123; OTHER=x; XSRF-TOKEN=tok; a=b'
  assert.equal(filterUpstreamCookies(header), 'SESSION=abc-123; XSRF-TOKEN=tok')
})

test('filterUpstreamCookies edge cases', () => {
  assert.equal(filterUpstreamCookies(undefined), undefined)
  assert.equal(filterUpstreamCookies(null), undefined)
  assert.equal(filterUpstreamCookies('__Host-dsh_auth_session=secret'), undefined)
  // 值里允许出现 '='：名字取第一个 '=' 之前
  assert.equal(filterUpstreamCookies('session=with=equals'), 'session=with=equals')
  // 大小写不敏感 + 空段容忍
  assert.equal(filterUpstreamCookies('  ;  Session = s1 ;  '), 'Session = s1')
  assert.equal(filterUpstreamCookies('  ;  ; '), undefined)
})

test('makeTlsPinChecker TOFU lifecycle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obmc-trust-'))
  try {
    const file = path.join(dir, 'trust.json')
    const checker = makeTlsPinChecker('10.0.0.8:443', file)
    // 首次见到即钉扎
    assert.doesNotThrow(() => checker(null, { fingerprint256: 'AA:00' }))
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pins['10.0.0.8:443'], 'AA:00')
    // 相同指纹通过
    assert.doesNotThrow(() => checker(null, { fingerprint256: 'AA:00' }))
    // 指纹变更：拒绝一次 + 旧钉扎作废
    assert.throws(() => checker(null, { fingerprint256: 'BB:01' }), /TOFU pin mismatch/)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pins['10.0.0.8:443'], undefined)
    // 下一次请求重新钉扎
    assert.doesNotThrow(() => checker(null, { fingerprint256: 'BB:01' }))
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pins['10.0.0.8:443'], 'BB:01')
    // 无 BMC_TARGET → 不设检查器（钉扎停用）
    assert.equal(makeTlsPinChecker(null, file), undefined)
    // 缺指纹（异常路径）不炸交换
    assert.doesNotThrow(() => checker(null, {}))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
