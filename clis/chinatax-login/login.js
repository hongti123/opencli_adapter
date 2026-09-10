import fs from 'node:fs';
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const DEFAULT_LOGIN_URL = 'https://tpass.guangdong.chinatax.gov.cn:8443/#/login?redirect_uri=https%3A%2F%2Fetax.guangdong.chinatax.gov.cn%3A8443%2Fmhzx%2Fapi%2Fmh%2Ftpass%2Fcode&client_id=c5djdncfa7nj4n2cajna2j68cndbj2fc&response_type=code&state=36220f4422f0472da8fa1c73f3bc3717';
const DEFAULT_SMS_FILE = 'D:\\元思工作空间\\定时检测短信转发\\latest_code.txt';
const SMS_CODE_RE = /^\d{4,8}$/;
const SMS_LOGIN_OUTCOME_TIMEOUT_SECONDS = 60;
const SMS_REJECTION_MARKERS = ['验证码错误', '验证码不正确', '验证码已失效', '验证码已过期', '请重新获取验证码'];

if (!process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT) {
  process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT = '600';
}

function required(value, envNames, label) {
  const names = Array.isArray(envNames) ? envNames : [envNames];
  const envValue = names.map((name) => process.env[name]).find((item) => item);
  const result = String(value || envValue || '').trim();
  if (!result) throw new ArgumentError(`${label} is required via argument or ${names.join(' / ')}`);
  return result;
}

function positiveInt(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) {
    throw new ArgumentError(`${label} must be a positive integer`);
  }
  return result;
}

function parseLoginTarget(value) {
  const loginUrl = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(loginUrl);
  } catch {
    throw new ArgumentError('login-url must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ArgumentError('login-url must use HTTP or HTTPS');
  }

  return {
    loginUrl: parsed.href,
    loginDomain: parsed.hostname,
  };
}

async function snapshot(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const body = document.body.innerText || '';
    const visibleInputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const inputs = visibleInputs.map((input) => ({
      placeholder: input.placeholder || '',
      type: input.type || '',
      value: input.value || '',
    }));
    return {
      url: location.href,
      body,
      inputs,
      captcha: Boolean(document.querySelector('#tpass-captcha')),
      enterpriseForm: visibleInputs.length >= 3 && visibleInputs.some((input) => input.type === 'password') && Boolean(document.querySelector('button.loginCls')),
      smsPage: visibleInputs.some((input) => input.maxLength === 6) && Boolean(document.querySelector('button.codeDivCls')),
    };
  })()`);
}

async function markByText(page, marker, texts, selectors = 'button, [role="button"], div, span') {
  const wanted = Array.isArray(texts) ? texts : [texts];
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
    const wanted = ${JSON.stringify(wanted)};
    document.querySelectorAll('[data-opencli-${marker}]').forEach((el) => el.removeAttribute('data-opencli-${marker}'));
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selectors)})).filter(visible)
      .sort((a, b) => textOf(a).length - textOf(b).length);
    let target = nodes.find((el) => wanted.includes(textOf(el)));
    if (!target) return false;
    target = target.closest('button, [role="button"]') || target;
    target.setAttribute('data-opencli-${marker}', '1');
    return true;
  })()`);
}

async function clickMarked(page, marker, errorMessage) {
  const selector = `[data-opencli-${marker}]`;
  const clicked = await page.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new CommandExecutionError(errorMessage);
}

async function setVisibleInput(page, placeholderParts, value) {
  const result = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const parts = ${JSON.stringify(placeholderParts)};
    const input = Array.from(document.querySelectorAll('input')).find((el) => visible(el) && parts.some((part) => (el.placeholder || '').includes(part)));
    if (!input) return { found: false, actual: '' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter ? setter.call(input, ${JSON.stringify(value)}) : (input.value = ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return { found: true, actual: input.value || '' };
  })()`);
  if (!result.found) throw new CommandExecutionError(`Input not found: ${placeholderParts.join(' / ')}`);
  if (result.actual !== value) throw new CommandExecutionError(`Input did not retain value: ${placeholderParts.join(' / ')}`);
}

async function openEnterpriseForm(page, loginUrl) {
  await page.goto(loginUrl);
  const initialDeadline = Date.now() + 20000;
  let state = await snapshot(page);
  while (Date.now() < initialDeadline && !state.enterpriseForm && !state.smsPage) {
    await page.wait(0.5);
    state = await snapshot(page);
  }
  if (state.enterpriseForm) return;

  if (state.smsPage && await markByText(page, 'tax-sms-back', ['<返回', '返回'])) {
    await clickMarked(page, 'tax-sms-back', 'SMS login back button not found');
    await page.wait(1);
    state = await snapshot(page);
  }
  if (state.enterpriseForm) return;

  if (await markByText(page, 'tax-top-login', ['登录', '“多合一”登录'])) {
    await clickMarked(page, 'tax-top-login', 'Top login entry not found');
    await page.wait(2);
    state = await snapshot(page);
  }
  if (state.enterpriseForm) return;

  if (await markByText(page, 'tax-account-login', '账号密码登录')) {
    await clickMarked(page, 'tax-account-login', 'Account/password login entry not found');
    await page.wait(1);
  }
  if (await markByText(page, 'tax-enterprise-tab', '企业业务')) {
    await clickMarked(page, 'tax-enterprise-tab', 'Enterprise business tab not found');
    await page.wait(1);
  }
  const formDeadline = Date.now() + 15000;
  state = await snapshot(page);
  while (Date.now() < formDeadline && !state.enterpriseForm) {
    await page.wait(0.5);
    state = await snapshot(page);
  }
  if (!state.enterpriseForm) throw new CommandExecutionError('Enterprise login form did not appear');
}

async function submitCredentials(page, taxpayerId, mobile, password) {
  const result = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const passwordInput = inputs.find((input) => input.type === 'password');
    const textInputs = inputs.filter((input) => input.type !== 'password');
    if (textInputs.length < 2 || !passwordInput) return { ok: false, reason: 'fields' };
    const set = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(input, value) : (input.value = value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    set(textInputs[0], ${JSON.stringify(taxpayerId)});
    set(textInputs[1], ${JSON.stringify(mobile)});
    set(passwordInput, ${JSON.stringify(password)});
    return { ok: textInputs[0].value === ${JSON.stringify(taxpayerId)} && textInputs[1].value === ${JSON.stringify(mobile)} && passwordInput.value === ${JSON.stringify(password)}, reason: 'verify' };
  })()`);
  if (!result.ok) throw new CommandExecutionError(`Enterprise login fields could not be filled (${result.reason})`);
  const clicked = await page.evaluate(`(() => { const button = document.querySelector('button.loginCls'); if (!button) return false; button.click(); return true; })()`);
  if (!clicked) throw new CommandExecutionError('Enterprise login button not found');
  await page.wait(0.5);
}

async function waitForManualCaptcha(page, timeoutSeconds) {
  const initialDeadline = Date.now() + 15000;
  let state = await snapshot(page);
  while (Date.now() < initialDeadline && !state.captcha && state.enterpriseForm && !state.smsPage) {
    await page.wait(0.5);
    state = await snapshot(page);
  }
  if (!state.captcha) return state;

  process.stderr.write('Manual CAPTCHA required. Complete it in the foreground Chrome window; OpenCLI will resume automatically.\n');
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    await page.wait(1);
    state = await snapshot(page);
    if (!state.captcha) return state;
  }
  throw new TimeoutError('manual CAPTCHA', timeoutSeconds);
}

function readSmsCode(filePath, previousFingerprint, requestedAtMs) {
  if (!fs.existsSync(filePath)) return '';
  const stat = fs.statSync(filePath);
  const code = fs.readFileSync(filePath, 'utf8').trim();
  if (!SMS_CODE_RE.test(code)) return '';
  const fingerprint = `${stat.mtimeMs}:${code}`;
  if (fingerprint === previousFingerprint || stat.mtimeMs < requestedAtMs - 1000) return '';
  return { code, fingerprint };
}

async function isLoggedIn(page, taxpayerId) {
  const signals = await page.evaluate(`(() => {
    const chunks = [];
    const visited = new Set();
    const collect = (root) => {
      if (!root || visited.has(root)) return;
      visited.add(root);
      const container = root.body || root.documentElement || root;
      chunks.push(container.innerText || '', container.textContent || '');
      root.querySelectorAll?.('*').forEach((el) => {
        if (el.shadowRoot) collect(el.shadowRoot);
      });
      root.querySelectorAll?.('iframe').forEach((frame) => {
        try {
          if (frame.contentDocument) collect(frame.contentDocument);
        } catch {}
      });
    };
    collect(document);
    const text = chunks.join('\n').replace(/\\s+/g, '');
    return {
      subjectInfo: text.includes('\u4e3b\u4f53\u4fe1\u606f'),
      taxpayerId: text.includes(${JSON.stringify(String(taxpayerId).replace(/\s+/g, ''))}),
    };
  })()`).catch(() => ({ subjectInfo: false, taxpayerId: false }));
  return signals.subjectInfo && signals.taxpayerId;
}

async function readSmsButtonState(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const codeInput = Array.from(document.querySelectorAll('input')).find((el) => el.maxLength === 6 && visible(el));
    const root = codeInput?.closest('form') || document;
    const button = document.querySelector('button.codeDivCls')
      || Array.from(root.querySelectorAll('button')).find((el) => !el.classList.contains('loginCls'));
    const text = (button?.innerText || button?.textContent || '').replace(/\\s+/g, '');
    const match = text.match(/^(\\d+)(?:s|\u79d2)$/i);
    return {
      exists: Boolean(button),
      visible: visible(button),
      disabled: Boolean(button?.disabled || button?.classList.contains('is-disabled')),
      text,
      countdownSeconds: match ? Number(match[1]) : null,
    };
  })()`);
}

async function clickGetSmsCode(page, taxpayerId) {
  const clicked = await page.evaluate(`(() => {
    const codeInput = Array.from(document.querySelectorAll('input')).find((el) => el.maxLength === 6);
    const root = codeInput?.closest('form') || document;
    const button = document.querySelector('button.codeDivCls')
      || Array.from(root.querySelectorAll('button')).find((el) => !el.classList.contains('loginCls'));
    if (!button || button.disabled || button.classList.contains('is-disabled')) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new CommandExecutionError('Get SMS verification code button not found or disabled');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page, taxpayerId)) return 'logged-in';
    const started = await page.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      return buttons.some((el) => {
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, '');
        return /^\\d+s$/.test(text) || text.includes('秒');
      });
    })()`);
    if (started) return 'requested';
    await page.wait(0.25);
  }
  if (await isLoggedIn(page, taxpayerId)) return 'logged-in';
  throw new CommandExecutionError('SMS request click did not start the countdown');
}

async function waitForSmsButton(page, timeoutSeconds, taxpayerId) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  process.stderr.write('SMS stage: checking whether a code was already requested.\n');
  while (Date.now() < deadline) {
    if (await isLoggedIn(page, taxpayerId)) return { mode: 'logged-in' };
    const state = await readSmsButtonState(page);
    if (state.visible && state.countdownSeconds !== null) return { mode: 'countdown', ...state };
    if (state.visible && !state.disabled) return { mode: 'ready', ...state };
    await page.wait(1);
  }
  throw new TimeoutError('SMS request button', timeoutSeconds);
}

async function confirmDefaultIdentityType(page, taxpayerId, timeoutSeconds = 15) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((el) =>
        visible(el) && el.getAttribute('aria-label') === '\u8eab\u4efd\u7c7b\u578b\u9009\u62e9'
      );
      if (!dialog) return { appeared: false, confirmed: false };
      const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]')).filter(visible);
      const confirmText = '\u786e\u8ba4';
      const button = buttons.find((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '') === confirmText);
      if (!button) return { appeared: true, confirmed: false };
      button.click();
      return { appeared: true, confirmed: true };
    })()`);
    if (result.confirmed) {
      process.stderr.write('Identity type dialog detected; kept the default selection and clicked Confirm.\n');
      await page.wait(2);
      return true;
    }
    if (result.appeared) throw new CommandExecutionError('Identity type dialog appeared, but its confirm button was not found');
    if (await isLoggedIn(page, taxpayerId)) return false;
    await page.wait(0.5);
  }
  return false;
}

async function submitSmsCode(page, code, taxpayerId, loginTarget) {
  const filled = await page.evaluate(`(() => {
    const input = Array.from(document.querySelectorAll('input')).find((el) => el.maxLength === 6);
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter ? setter.call(input, ${JSON.stringify(code)}) : (input.value = ${JSON.stringify(code)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return input.value === ${JSON.stringify(code)};
  })()`);
  if (!filled) throw new CommandExecutionError('SMS verification code input not found or did not retain its value');
  const clicked = await page.evaluate(`(() => { const button = document.querySelector('button.loginCls'); if (!button) return false; button.click(); return true; })()`);
  if (!clicked) throw new CommandExecutionError('SMS login button not found');
  process.stderr.write('SMS code file updated; submitted the code and clicked Login.\n');
  await confirmDefaultIdentityType(page, taxpayerId);
  process.stderr.write(`Waiting for subject information and taxpayer ${taxpayerId} (up to ${SMS_LOGIN_OUTCOME_TIMEOUT_SECONDS}s).\n`);
  const deadline = Date.now() + SMS_LOGIN_OUTCOME_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page, taxpayerId)) {
      process.stderr.write('Tax platform login success detected.\n');
      return true;
    }
    const state = await snapshot(page);
    if (state.body.includes('身份认证已失效') || state.body.includes('请重新登录')) {
      throw new AuthRequiredError(loginTarget.loginDomain, 'Tax login authentication expired; restart from the enterprise credential form and complete the CAPTCHA again');
    }
    if (SMS_REJECTION_MARKERS.some((marker) => state.body.includes(marker))) {
      process.stderr.write('The tax platform rejected the submitted SMS code; another SMS round may be attempted.\n');
      return false;
    }
    await page.wait(1);
  }
  process.stderr.write('Login success was not confirmed within 60s; another SMS round may be attempted.\n');
  return false;
}

async function completeSmsLogin(page, filePath, rounds, roundSeconds, pollSeconds, taxpayerId, loginTarget) {
  if (!fs.existsSync(filePath)) throw new CommandExecutionError(`SMS code file not found: ${filePath}`);
  const initialStat = fs.statSync(filePath);
  const initialCode = fs.readFileSync(filePath, 'utf8').trim();
  let previousFingerprint = `${initialStat.mtimeMs}:${initialCode}`;

  for (let round = 1; round <= rounds; round += 1) {
    const buttonState = await waitForSmsButton(page, roundSeconds + 30, taxpayerId);
    if (buttonState.mode === 'logged-in') return Math.max(0, round - 1);

    let requestedAt;
    if (buttonState.mode === 'countdown') {
      const elapsedSeconds = Math.max(0, roundSeconds - Math.min(roundSeconds, buttonState.countdownSeconds));
      requestedAt = Date.now() - elapsedSeconds * 1000;
      const currentStat = fs.statSync(filePath);
      if (currentStat.mtimeMs >= requestedAt - 1000) previousFingerprint = '';
      process.stderr.write(`SMS round ${round}/${rounds}: a code was already requested; countdown ${buttonState.countdownSeconds}s. Polling the SMS file now.\n`);
    } else {
      process.stderr.write(`SMS round ${round}/${rounds}: requesting a new code.\n`);
      const requestResult = await clickGetSmsCode(page, taxpayerId);
      if (requestResult === 'logged-in') return round > 1 ? round - 1 : 0;
      requestedAt = Date.now();
    }
    const deadline = requestedAt + roundSeconds * 1000;
    process.stderr.write(`SMS round ${round}/${rounds}: waiting for ${filePath} to update.\n`);
    while (Date.now() < deadline) {
      if (await isLoggedIn(page, taxpayerId)) return round;
      const update = readSmsCode(filePath, previousFingerprint, requestedAt);
      if (update) {
        previousFingerprint = update.fingerprint;
        const loginSucceeded = await submitSmsCode(page, update.code, taxpayerId, loginTarget);
        if (loginSucceeded || await isLoggedIn(page, taxpayerId)) return round;
      }
      await page.wait(pollSeconds);
    }
  }
  throw new CommandExecutionError(`SMS verification did not succeed after ${rounds} rounds`);
}

cli({
  site: 'chinatax-login',
  name: 'login',
  description: 'Log in to a provincial Electronic Tax Service using a configurable login URL, pause for manual CAPTCHA, then poll an SMS code file.',
  access: 'read',
  example: 'opencli --profile 5h6k9bkm chinatax-login login --login-url "<provincial-login-url>" --site-session persistent --keep-tab true --window foreground -f yaml',
  domain: 'chinatax.gov.cn',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'login-url', type: 'string', default: '', help: 'Provincial tax login URL. Defaults to CHINATAX_LOGIN_URL, then the Guangdong login URL.' },
    { name: 'url', type: 'string', default: '', help: 'Legacy alias for --login-url.' },
    { name: 'taxpayer-id', type: 'string', default: '91442000MAK5139B95', help: 'Taxpayer identification number. Supports CHINATAX_TAXPAYER_ID and legacy GD_CHINATAX_TAXPAYER_ID.' },
    { name: 'mobile', type: 'string', default: '胡海艳1', help: 'Login mobile/user identifier. Supports CHINATAX_MOBILE and legacy GD_CHINATAX_MOBILE.' },
    { name: 'password', type: 'string', default: '', help: 'User password. Supports CHINATAX_PASSWORD and legacy GD_CHINATAX_PASSWORD.' },
    { name: 'sms-file', type: 'string', default: DEFAULT_SMS_FILE, help: 'File containing the latest SMS verification code.' },
    { name: 'captcha-timeout', type: 'int', default: 300, help: 'Seconds to wait for manual CAPTCHA completion.' },
    { name: 'sms-rounds', type: 'int', default: 3, help: 'Maximum SMS request rounds.' },
    { name: 'sms-round-seconds', type: 'int', default: 120, help: 'Polling window per SMS request round; defaults to the observed page countdown.' },
    { name: 'sms-poll-seconds', type: 'int', default: 2, help: 'SMS file polling interval.' },
    { name: 'timeout', type: 'int', default: 600, help: 'Max seconds for the overall command (default: 600).' },
  ],
  columns: ['status', 'smsRounds', 'taxpayerId', 'subjectInfo', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for chinatax-login login');
    const taxpayerId = required(kwargs.taxpayerId ?? kwargs['taxpayer-id'], ['CHINATAX_TAXPAYER_ID', 'GD_CHINATAX_TAXPAYER_ID'], 'taxpayer-id');
    const mobile = required(kwargs.mobile, ['CHINATAX_MOBILE', 'GD_CHINATAX_MOBILE'], 'mobile');
    const password = required(kwargs.password, ['CHINATAX_PASSWORD', 'GD_CHINATAX_PASSWORD'], 'password');
    const captchaTimeout = positiveInt(kwargs.captchaTimeout ?? kwargs['captcha-timeout'], 'captcha-timeout');
    const smsRounds = positiveInt(kwargs.smsRounds ?? kwargs['sms-rounds'], 'sms-rounds');
    const smsRoundSeconds = positiveInt(kwargs.smsRoundSeconds ?? kwargs['sms-round-seconds'], 'sms-round-seconds');
    const smsPollSeconds = positiveInt(kwargs.smsPollSeconds ?? kwargs['sms-poll-seconds'], 'sms-poll-seconds');
    const loginUrl = String(kwargs.loginUrl ?? kwargs['login-url'] ?? '').trim()
      || String(kwargs.url ?? '').trim()
      || String(process.env.CHINATAX_LOGIN_URL || '').trim()
      || DEFAULT_LOGIN_URL;
    const loginTarget = parseLoginTarget(loginUrl);

    await openEnterpriseForm(page, loginTarget.loginUrl);
    await submitCredentials(page, taxpayerId, mobile, password);
    const state = await waitForManualCaptcha(page, captchaTimeout);
    if (await isLoggedIn(page, taxpayerId)) return [{ status: 'ok', smsRounds: 0, taxpayerId, subjectInfo: true, url: state.url }];
    if (!state.smsPage) throw new CommandExecutionError('Manual CAPTCHA ended, but the SMS verification page did not appear');
    const usedRounds = await completeSmsLogin(page, String(kwargs.smsFile ?? kwargs['sms-file'] ?? DEFAULT_SMS_FILE), smsRounds, smsRoundSeconds, smsPollSeconds, taxpayerId, loginTarget);
    const finalState = await snapshot(page);
    if (!await isLoggedIn(page, taxpayerId)) {
      throw new CommandExecutionError(`Login page did not show subject information for taxpayer ${taxpayerId}`);
    }
    return [{ status: 'ok', smsRounds: usedRounds, taxpayerId, subjectInfo: true, url: finalState.url }];
  },
});
