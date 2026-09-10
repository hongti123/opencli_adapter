import { ArgumentError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const DEFAULT_TIMEOUT_SECONDS = 30;
const ACCOUNT_TRIGGER_SELECTOR = '#NavTopPopup';
const LOGOUT_MARKER_SELECTOR = '[data-opencli-chinatax-logout]';

function requiredPortalUrl(kwargs) {
  const value = [
    kwargs.portalUrl,
    kwargs['portal-url'],
    kwargs.logoutUrl,
    kwargs['logout-url'],
    kwargs.url,
    process.env.CHINATAX_LOGOUT_URL,
    process.env.CHINATAX_PORTAL_URL,
  ].map((item) => String(item ?? '').trim()).find(Boolean) || '';
  if (!value) {
    throw new ArgumentError('portal-url is required via --portal-url, CHINATAX_LOGOUT_URL, or CHINATAX_PORTAL_URL');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ArgumentError('portal-url must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ArgumentError('portal-url must use HTTP or HTTPS');
  }
  return parsed;
}

function positiveInt(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) {
    throw new ArgumentError(`${label} must be a positive integer`);
  }
  return result;
}

async function snapshot(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const compact = (value) => String(value || '').replace(/\\s+/g, '').trim();
    const bodyText = compact(document.body?.innerText || document.body?.textContent || '');
    const accountTrigger = document.querySelector(${JSON.stringify(ACCOUNT_TRIGGER_SELECTOR)});
    const loginEntry = Array.from(document.querySelectorAll('.loginBtn, .loginBtnText'))
      .find((el) => visible(el) && compact(el.innerText || el.textContent) === '\u767b\u5f55');
    const visibleInputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const loginButton = Array.from(document.querySelectorAll('button')).find((el) =>
      visible(el) && compact(el.innerText || el.textContent) === '\u767b\u5f55'
    );
    return {
      url: location.href,
      title: document.title || '',
      accountTriggerVisible: visible(accountTrigger),
      loginVisible: Boolean(loginEntry),
      loginFormVisible: Boolean(loginButton)
        && visibleInputs.some((input) => input.type === 'password')
        && visibleInputs.some((input) => compact(input.placeholder).includes('\u7eb3\u7a0e\u4eba\u8bc6\u522b\u53f7')),
      subjectInfo: bodyText.includes('\u4e3b\u4f53\u4fe1\u606f'),
    };
  })()`);
}

function loginSurface(state, portalTarget) {
  let current;
  try {
    current = new URL(state.url);
  } catch {
    return null;
  }
  if (current.origin === portalTarget.origin
    && !current.pathname.startsWith('/loginb')
    && state.loginVisible) {
    return 'portal-login-entry';
  }
  if ((current.hostname === 'chinatax.gov.cn' || current.hostname.endsWith('.chinatax.gov.cn'))
    && current.hash.startsWith('#/login')
    && state.loginFormVisible) {
    return 'identity-login-form';
  }
  return null;
}

function isLoggedOut(state, portalTarget) {
  return Boolean(loginSurface(state, portalTarget))
    && !state.accountTriggerVisible
    && !state.subjectInfo;
}

async function waitForPortalState(page, portalTarget, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let state = await snapshot(page);
  while (Date.now() < deadline) {
    if (isLoggedOut(state, portalTarget) || state.accountTriggerVisible) return state;
    await page.wait(0.5);
    state = await snapshot(page);
  }
  throw new TimeoutError('tax portal login or account controls', timeoutSeconds);
}

async function markLogoutControl(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const compact = (value) => String(value || '').replace(/\\s+/g, '').trim();
    document.querySelectorAll(${JSON.stringify(LOGOUT_MARKER_SELECTOR)})
      .forEach((el) => el.removeAttribute('data-opencli-chinatax-logout'));

    const menuItems = Array.from(document.querySelectorAll('#NavTopPopup .grlist')).filter(visible);
    const target = menuItems.find((el) => el.querySelector('.t-icon-logout'))
      || menuItems.find((el) => compact(el.innerText || el.textContent) === '\u9000\u51fa\u767b\u5f55');
    if (!target) return false;
    target.setAttribute('data-opencli-chinatax-logout', '1');
    return true;
  })()`);
}

async function openLogoutMenu(page) {
  try {
    await page.hover(ACCOUNT_TRIGGER_SELECTOR);
  } catch (error) {
    throw new CommandExecutionError(`Tax account menu could not be hovered: ${error?.message || error}`);
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await markLogoutControl(page)) return;
    await page.wait(0.25);
  }
  throw new CommandExecutionError('Logout control did not appear after hovering the tax account menu');
}

async function clickLogout(page) {
  try {
    await page.click(LOGOUT_MARKER_SELECTOR);
  } catch (error) {
    throw new CommandExecutionError(`Tax logout control could not be clicked: ${error?.message || error}`);
  }
}

async function waitForLoggedOutState(page, portalTarget, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let state = await snapshot(page);
  while (Date.now() < deadline) {
    if (isLoggedOut(state, portalTarget)) return state;
    await page.wait(0.5);
    state = await snapshot(page);
  }
  throw new TimeoutError('tax logout confirmation', timeoutSeconds);
}

cli({
  site: 'chinatax-logout',
  name: 'logout',
  description: 'Open a provincial Electronic Tax Service portal, hover the current subject menu, and log out of the active subject.',
  access: 'write',
  example: 'opencli --profile opc-default chinatax-logout logout --portal-url "https://etax.guangdong.chinatax.gov.cn:8443/loginb/" --site-session persistent --keep-tab true --window foreground -f yaml',
  domain: 'chinatax.gov.cn',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'portal-url', type: 'string', default: '', help: 'Authenticated tax portal URL. Required via this argument, CHINATAX_LOGOUT_URL, or CHINATAX_PORTAL_URL.' },
    { name: 'logout-url', type: 'string', default: '', help: 'Alias for --portal-url.' },
    { name: 'url', type: 'string', default: '', help: 'Legacy alias for --portal-url.' },
    { name: 'timeout', type: 'int', default: DEFAULT_TIMEOUT_SECONDS, help: 'Seconds to wait for portal controls and logout confirmation.' },
  ],
  columns: ['status', 'alreadyLoggedOut', 'loginSurface', 'loginVisible', 'loginFormVisible', 'subjectInfo', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for chinatax-logout logout');
    const portalTarget = requiredPortalUrl(kwargs);
    const timeoutSeconds = positiveInt(kwargs.timeout ?? DEFAULT_TIMEOUT_SECONDS, 'timeout');

    try {
      await page.goto(portalTarget.href);
    } catch (error) {
      throw new CommandExecutionError(`Tax portal navigation failed: ${error?.message || error}`);
    }

    const initialState = await waitForPortalState(page, portalTarget, timeoutSeconds);
    if (isLoggedOut(initialState, portalTarget)) {
      return [{
        status: 'ok',
        alreadyLoggedOut: true,
        loginSurface: loginSurface(initialState, portalTarget),
        loginVisible: initialState.loginVisible,
        loginFormVisible: initialState.loginFormVisible,
        subjectInfo: initialState.subjectInfo,
        url: initialState.url,
      }];
    }

    await openLogoutMenu(page);
    await clickLogout(page);
    const finalState = await waitForLoggedOutState(page, portalTarget, timeoutSeconds);
    return [{
      status: 'ok',
      alreadyLoggedOut: false,
      loginSurface: loginSurface(finalState, portalTarget),
      loginVisible: finalState.loginVisible,
      loginFormVisible: finalState.loginFormVisible,
      subjectInfo: finalState.subjectInfo,
      url: finalState.url,
    }];
  },
});
