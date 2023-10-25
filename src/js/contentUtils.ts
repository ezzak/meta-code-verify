/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  KNOWN_EXTENSION_HASHES,
  MESSAGE_TYPE,
  DOWNLOAD_JS_ENABLED,
  STATES,
  Origin,
  ORIGIN_TYPE,
} from './config';

import {
  checkDocumentCSPHeaders,
  getAllowedWorkerCSPs,
} from './content/checkDocumentCSPHeaders';
import downloadJSArchive from './content/downloadJSArchive';
import alertBackgroundOfImminentFetch from './content/alertBackgroundOfImminentFetch';
import {
  getCurrentOrigin,
  setCurrentOrigin,
  updateCurrentState,
  invalidateAndThrow,
} from './content/updateCurrentState';
import checkElementForViolatingJSUri from './content/checkElementForViolatingJSUri';
import {checkElementForViolatingAttributes} from './content/checkElementForViolatingAttributes';
import {sendMessageToBackground} from './shared/sendMessageToBackground';
import parseFailedJSON from './content/parseFailedJSON';
import genSourceText from './content/genSourceText';
import isPathnameExcluded from './content/isPathNameExcluded';
import {doesWorkerUrlConformToCSP} from './content/doesWorkerUrlConformToCSP';
import {checkWorkerEndpointCSP} from './content/checkWorkerEndpointCSP';
import {MessagePayload} from './shared/MessageTypes';
import ensureManifestWasOrWillBeLoaded from './content/ensureManifestWasOrWillBeLoaded';

type ContentScriptConfig = {
  checkLoggedInFromCookie: boolean;
  enforceCSPHeaders: boolean;
  excludedPathnames: Array<RegExp>;
  longTailIsLoadedConditionally: boolean;
  scriptsShouldHaveManifestProp: boolean;
  useCompanyManifest: boolean;
};

let originConfig: ContentScriptConfig = {
  checkLoggedInFromCookie: false,
  enforceCSPHeaders: false,
  excludedPathnames: [],
  longTailIsLoadedConditionally: false,
  scriptsShouldHaveManifestProp: false,
  useCompanyManifest: false,
};

const SOURCE_SCRIPTS = new Map();
/**
 * using an array of maps, as we're using the same key for inline scripts
 * this will eventually be removed, once inline scripts are removed from the
 * page load
 * */
const INLINE_SCRIPTS: Array<Map<string, string>> = [];

// Map<version, Array<ScriptDetails>>
export const UNINITIALIZED = 'UNINITIALIZED';
const BOTH = 'BOTH';
let currentFilterType = UNINITIALIZED;
export const FOUND_SCRIPTS = new Map<string, Array<ScriptDetails>>([
  [UNINITIALIZED, []],
]);
const ALL_FOUND_SCRIPT_TAGS = new Set();
const FOUND_MANIFEST_VERSIONS = new Set<string>();

type ScriptDetailsWithSrc = {
  otherType: string;
  src: string;
};
type ScriptDetailsRaw = {
  type: typeof MESSAGE_TYPE.RAW_JS;
  rawjs: string;
  lookupKey: string;
  otherType: string;
};
type ScriptDetails = ScriptDetailsRaw | ScriptDetailsWithSrc;
let manifestTimeoutID: string | number = '';

export type RawManifestOtherHashes = {
  combined_hash: string;
  longtail: string;
  main: string;
};
type RawManifest = {
  manifest: Array<string>;
  manifest_hashes: RawManifestOtherHashes;
  leaves: Array<string>;
  root: string;
  version: string;
};

function isTopWindow(): boolean {
  return window == window.top;
}
function isSameDomainAsTopWindow(): boolean {
  try {
    // This is inside a try/catch because even attempting to access the `origin`
    // property will throw a SecurityError if the domains don't match.
    return window.location.origin === window.top!.location.origin;
  } catch {
    return false;
  }
}

export function storeFoundJS(scriptNodeMaybe: HTMLScriptElement): void {
  if (!isTopWindow() && isSameDomainAsTopWindow()) {
    // this means that content utils is running in an iframe - disable timer and call processFoundJS on manifest processed in top level frame
    clearTimeout(manifestTimeoutID);
    manifestTimeoutID = '';
    FOUND_SCRIPTS.forEach((_val, key) => {
      window.setTimeout(() => processFoundJS(key), 0);
    });
  }
  // check if it's the manifest node
  if (
    (isTopWindow() || !isSameDomainAsTopWindow()) &&
    (scriptNodeMaybe.id === 'binary-transparency-manifest' ||
      scriptNodeMaybe.getAttribute('name') === 'binary-transparency-manifest')
  ) {
    if (scriptNodeMaybe.getAttribute('type') !== 'application/json') {
      updateCurrentState(STATES.INVALID, 'Manifest script type is invalid');
      return;
    }

    let rawManifest: RawManifest | null = null;
    try {
      rawManifest = JSON.parse(scriptNodeMaybe.textContent!);
      if (!rawManifest) {
        throw new Error('rawManifest is null or empty');
      }
    } catch (manifestParseError) {
      setTimeout(
        () => parseFailedJSON({node: scriptNodeMaybe, retry: 5000}),
        20,
      );
      return;
    }

    let leaves = rawManifest.leaves;
    let otherType = '';
    let roothash = rawManifest.root;
    let version = rawManifest.version;
    let messagePayload: MessagePayload;
    if (originConfig.longTailIsLoadedConditionally) {
      leaves = rawManifest.manifest;
      const otherHashes = rawManifest.manifest_hashes;
      roothash = otherHashes.combined_hash;

      const maybeManifestType =
        scriptNodeMaybe.getAttribute('data-manifest-type');
      if (maybeManifestType === null) {
        updateCurrentState(
          STATES.INVALID,
          'manifest is missing `data-manifest-type` prop',
        );
      } else {
        otherType = maybeManifestType;
      }

      const maybeManifestRev =
        scriptNodeMaybe.getAttribute('data-manifest-rev');
      if (maybeManifestRev === null) {
        updateCurrentState(
          STATES.INVALID,
          'manifest is missing `data-manifest-rev` prop',
        );
      } else {
        version = maybeManifestRev;
      }

      // If this is the first manifest we've found, start processing scripts for
      // that type. If we have encountered a second manifest, we can assume both
      // main and longtail manifests are present.
      if (currentFilterType === UNINITIALIZED) {
        currentFilterType = otherType;
      } else {
        currentFilterType = BOTH;
      }

      messagePayload = {
        type: MESSAGE_TYPE.LOAD_COMPANY_MANIFEST,
        leaves,
        origin: getCurrentOrigin(),
        otherHashes: otherHashes,
        rootHash: roothash,
        workaround: scriptNodeMaybe.innerHTML,
        version,
      };
    } else {
      // for whatsapp
      currentFilterType = BOTH;

      messagePayload = {
        type: MESSAGE_TYPE.LOAD_MANIFEST,
        leaves,
        origin: getCurrentOrigin(),
        rootHash: roothash,
        workaround: scriptNodeMaybe.innerHTML,
        version,
      };
    }

    // now that we know the actual version of the scripts, transfer the ones we know about.
    // also set the correct manifest type, "otherType" for already collected scripts
    const foundScriptsWithoutVersion = FOUND_SCRIPTS.get(UNINITIALIZED);
    if (foundScriptsWithoutVersion) {
      const scriptsWithUpdatedType = foundScriptsWithoutVersion.map(script => ({
        ...script,
        otherType: currentFilterType,
      }));

      FOUND_SCRIPTS.set(version, [
        ...scriptsWithUpdatedType,
        ...(FOUND_SCRIPTS.get(version) ?? []),
      ]);
      FOUND_SCRIPTS.delete(UNINITIALIZED);
    } else if (!FOUND_SCRIPTS.has(version)) {
      // New version is being loaded in
      FOUND_SCRIPTS.set(version, []);
    }

    sendMessageToBackground(messagePayload, response => {
      // then start processing of it's JS
      if (response.valid) {
        if (manifestTimeoutID !== '') {
          clearTimeout(manifestTimeoutID);
          manifestTimeoutID = '';
        }
        FOUND_MANIFEST_VERSIONS.add(version);
        window.setTimeout(() => processFoundJS(version), 0);
      } else {
        if ('UNKNOWN_ENDPOINT_ISSUE' === response.reason) {
          updateCurrentState(STATES.TIMEOUT);
          return;
        }
        updateCurrentState(STATES.INVALID);
      }
    });
  }

  if (scriptNodeMaybe.getAttribute('type') === 'application/json') {
    try {
      JSON.parse(scriptNodeMaybe.textContent!);
    } catch (parseError) {
      setTimeout(
        () => parseFailedJSON({node: scriptNodeMaybe, retry: 1500}),
        20,
      );
    }
    return;
  }
  if (
    scriptNodeMaybe.src != null &&
    scriptNodeMaybe.src !== '' &&
    scriptNodeMaybe.src.indexOf('blob:') === 0
  ) {
    // TODO: try to process the blob. For now, flag as warning.
    updateCurrentState(STATES.INVALID, 'blob: src');
    return;
  }

  // Need to get the src of the JS
  let scriptDetails: ScriptDetails;
  let version = UNINITIALIZED;

  if (scriptNodeMaybe.src !== '' || scriptNodeMaybe.innerHTML !== '') {
    if (originConfig.scriptsShouldHaveManifestProp) {
      const dataBtManifest = scriptNodeMaybe.getAttribute('data-btmanifest');
      if (dataBtManifest == null) {
        invalidateAndThrow(
          `No data-btmanifest attribute found on script ${scriptNodeMaybe.src}`,
        );
      }
      version = dataBtManifest.split('_')[0];
      const otherType = dataBtManifest.split('_')[1];
      scriptDetails = {
        src: scriptNodeMaybe.src,
        otherType,
      };
      ALL_FOUND_SCRIPT_TAGS.add(scriptNodeMaybe.src);
      ensureManifestWasOrWillBeLoaded(FOUND_MANIFEST_VERSIONS, version);
    } else {
      if (scriptNodeMaybe.src !== '') {
        scriptDetails = {
          src: scriptNodeMaybe.src,
          otherType: currentFilterType,
        };
        ALL_FOUND_SCRIPT_TAGS.add(scriptNodeMaybe.src);
        ensureManifestWasOrWillBeLoaded(FOUND_MANIFEST_VERSIONS, version);
      } else {
        // no src, access innerHTML for the code
        const hashLookupAttribute =
          // @ts-ignore: This is just sort of hole in the DOM definitions.
          scriptNodeMaybe.attributes['data-binary-transparency-hash-key'];
        const hashLookupKey = hashLookupAttribute && hashLookupAttribute.value;
        scriptDetails = {
          type: MESSAGE_TYPE.RAW_JS,
          rawjs: scriptNodeMaybe.innerHTML,
          lookupKey: hashLookupKey,
          otherType: currentFilterType,
        };
      }
    }

    const scriptsForVersion = FOUND_SCRIPTS.get(version);
    if (scriptsForVersion) {
      scriptsForVersion.push(scriptDetails);
    } else {
      if (version != UNINITIALIZED) {
        FOUND_SCRIPTS.set(version, [scriptDetails]);
      } else {
        FOUND_SCRIPTS.get(FOUND_SCRIPTS.keys().next().value)?.push(
          scriptDetails,
        );
      }
    }

    updateCurrentState(STATES.PROCESSING);
  }
}

function checkNodeForViolations(element: Element): void {
  checkElementForViolatingJSUri(element);
  checkElementForViolatingAttributes(element);
}

export function hasInvalidScripts(scriptNodeMaybe: Node): void {
  // if not an HTMLElement ignore it!
  if (scriptNodeMaybe.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  checkNodeForViolations(scriptNodeMaybe as Element);

  if (scriptNodeMaybe.nodeName.toLowerCase() === 'script') {
    storeFoundJS(scriptNodeMaybe as HTMLScriptElement);
  } else if (scriptNodeMaybe.childNodes.length > 0) {
    scriptNodeMaybe.childNodes.forEach(childNode => {
      hasInvalidScripts(childNode);
    });
  }
}

export const scanForScripts = (): void => {
  const allElements = document.getElementsByTagName('*');
  Array.from(allElements).forEach(element => {
    checkNodeForViolations(element);
    // next check for existing script elements and if they're violating
    if (element.nodeName.toLowerCase() === 'script') {
      storeFoundJS(element as HTMLScriptElement);
    }
  });

  try {
    // track any new scripts that get loaded in
    const scriptMutationObserver = new MutationObserver(mutationsList => {
      mutationsList.forEach(mutation => {
        if (mutation.type === 'childList') {
          Array.from(mutation.addedNodes).forEach(checkScript => {
            // Code within a script tag has changed
            if (
              checkScript.nodeType === Node.TEXT_NODE &&
              mutation.target.nodeName.toLocaleLowerCase() === 'script'
            ) {
              hasInvalidScripts(mutation.target);
            } else {
              hasInvalidScripts(checkScript);
            }
          });
        } else if (
          mutation.type === 'attributes' &&
          mutation.target.nodeType === Node.ELEMENT_NODE
        ) {
          checkNodeForViolations(mutation.target as Element);
        }
      });
    });

    scriptMutationObserver.observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  } catch (_UnknownError) {
    updateCurrentState(STATES.INVALID, 'unknown');
  }
};

async function processJSWithSrc(
  script: ScriptDetailsWithSrc,
  version: string,
): Promise<{
  valid: boolean;
  type?: unknown;
}> {
  // fetch the script from page context, not the extension context.
  try {
    await alertBackgroundOfImminentFetch(script.src);
    const sourceResponse = await fetch(script.src, {
      method: 'GET',
    });
    if (DOWNLOAD_JS_ENABLED) {
      const fileNameArr = script.src.split('/');
      const fileName = fileNameArr[fileNameArr.length - 1].split('?')[0];
      const responseBody = sourceResponse.clone().body;
      if (!responseBody) {
        throw new Error('Response for fetched script has no body');
      }
      SOURCE_SCRIPTS.set(
        fileName,
        responseBody.pipeThrough(new window.CompressionStream('gzip')),
      );
    }
    const sourceText = await genSourceText(sourceResponse);
    // split package up if necessary
    const packages = sourceText.split('/*FB_PKG_DELIM*/\n');
    const packagePromises = packages.map(jsPackage => {
      return new Promise((resolve, reject) => {
        sendMessageToBackground(
          {
            type: MESSAGE_TYPE.RAW_JS,
            rawjs: jsPackage.trimStart(),
            origin: getCurrentOrigin(),
            version: version,
          },
          response => {
            if (response.valid) {
              resolve(null);
            } else {
              reject();
            }
          },
        );
      });
    });
    await Promise.all(packagePromises);
    return {valid: true};
  } catch (scriptProcessingError) {
    return {
      valid: false,
      type: scriptProcessingError,
    };
  }
}

export const processFoundJS = async (version: string): Promise<void> => {
  const scriptsForVersion = FOUND_SCRIPTS.get(version);
  if (!scriptsForVersion) {
    invalidateAndThrow(
      `attempting to process scripts for nonexistent version ${version}`,
    );
  }
  const scripts = scriptsForVersion.splice(0).filter(script => {
    if (
      script.otherType === currentFilterType ||
      [BOTH, UNINITIALIZED].includes(currentFilterType)
    ) {
      return true;
    } else {
      scriptsForVersion.push(script);
    }
  });
  let pendingScriptCount = scripts.length;
  for (const script of scripts) {
    if ('src' in script) {
      // ScriptDetailsWithSrc
      await processJSWithSrc(script, version).then(response => {
        pendingScriptCount--;
        if (response.valid) {
          if (pendingScriptCount == 0) {
            updateCurrentState(STATES.VALID);
          }
        } else {
          if (response.type === 'EXTENSION') {
            updateCurrentState(STATES.RISK);
          } else {
            updateCurrentState(
              STATES.INVALID,
              `Invalid ScriptDetailsWithSrc ${script.src}`,
            );
          }
        }
        sendMessageToBackground({
          type: MESSAGE_TYPE.DEBUG,
          log:
            'processed JS with SRC response is ' +
            JSON.stringify(response).substring(0, 500),
          src: script.src,
        });
      });
    } else {
      // ScriptDetailsRaw
      sendMessageToBackground(
        {
          type: script.type,
          rawjs: script.rawjs.trimStart(),
          origin: getCurrentOrigin(),
          version: version,
        },
        response => {
          pendingScriptCount--;
          const inlineScriptMap = new Map();
          if (response.valid) {
            inlineScriptMap.set(response.hash!, script.rawjs);
            INLINE_SCRIPTS.push(inlineScriptMap);
            if (pendingScriptCount == 0) {
              updateCurrentState(STATES.VALID);
            }
          } else {
            inlineScriptMap.set('hash not in manifest', script.rawjs);
            INLINE_SCRIPTS.push(inlineScriptMap);
            if (KNOWN_EXTENSION_HASHES.includes(response.hash!)) {
              updateCurrentState(STATES.RISK);
            } else {
              updateCurrentState(STATES.INVALID, 'Invalid ScriptDetailsRaw');
            }
          }
          sendMessageToBackground({
            type: MESSAGE_TYPE.DEBUG,
            log:
              'processed the RAW_JS, response is ' +
              response.hash! +
              ' ' +
              JSON.stringify(response).substring(0, 500),
          });
        },
      );
    }
  }
  window.setTimeout(() => processFoundJS(version), 3000);
};

let isUserLoggedIn = false;
let allowedWorkerCSPs: Array<Set<string>> = [];

export function startFor(origin: Origin, config: ContentScriptConfig): void {
  originConfig = config;
  setCurrentOrigin(origin);
  sendMessageToBackground(
    {
      type: MESSAGE_TYPE.CONTENT_SCRIPT_START,
      checkCSPHeaders: originConfig.enforceCSPHeaders,
      origin,
    },
    resp => {
      if (originConfig.enforceCSPHeaders) {
        if (!resp.cspHeaders) {
          invalidateAndThrow(
            'Expected CSP Headers in CONTENT_SCRIPT_START response',
          );
        }
        const validCSP = checkDocumentCSPHeaders(
          resp.cspHeaders,
          resp.cspReportHeaders,
          getCurrentOrigin(),
        );
        if (validCSP) {
          allowedWorkerCSPs = getAllowedWorkerCSPs(resp.cspHeaders);
        }
      }
    },
  );
  if (isPathnameExcluded(originConfig.excludedPathnames)) {
    updateCurrentState(STATES.IGNORE);
    return;
  }
  if (originConfig.checkLoggedInFromCookie) {
    // ds_user_id / c_user contains the user id of the user logged in
    const cookieName =
      origin === ORIGIN_TYPE.INSTAGRAM ? 'ds_user_id' : 'c_user';
    const cookies = document.cookie.split(';');
    cookies.forEach(cookie => {
      const pair = cookie.split('=');
      if (pair[0].indexOf(cookieName) >= 0) {
        isUserLoggedIn = true;
      }
    });
  } else {
    // only doing this check for FB, MSGR, and IG
    isUserLoggedIn = true;
  }
  if (isUserLoggedIn) {
    updateCurrentState(STATES.PROCESSING);
    scanForScripts();
    // set the timeout once, in case there's an iframe and contentUtils sets another manifest timer
    if (manifestTimeoutID === '') {
      manifestTimeoutID = window.setTimeout(() => {
        // Manifest failed to load, flag a warning to the user.
        updateCurrentState(STATES.TIMEOUT);
      }, 45000);
    }
  }
}

chrome.runtime.onMessage.addListener(request => {
  if (request.greeting === 'downloadSource' && DOWNLOAD_JS_ENABLED) {
    downloadJSArchive(SOURCE_SCRIPTS, INLINE_SCRIPTS);
  } else if (request.greeting === 'nocacheHeaderFound') {
    updateCurrentState(
      STATES.INVALID,
      `Detected uncached script ${request.uncachedUrl}`,
    );
  } else if (request.greeting === 'checkIfScriptWasProcessed') {
    if (isUserLoggedIn && !ALL_FOUND_SCRIPT_TAGS.has(request.response.url)) {
      if (
        'serviceWorker' in navigator &&
        navigator.serviceWorker.controller?.scriptURL === request.response.url
      ) {
        return;
      }
      if (originConfig.enforceCSPHeaders) {
        const hostname = window.location.hostname;
        const resourceURL = new URL(request.response.url);
        if (resourceURL.hostname === hostname) {
          // This can potentially be a worker, check if CSPs allow it as a worker
          if (
            allowedWorkerCSPs.every(csp =>
              doesWorkerUrlConformToCSP(csp, resourceURL.toString()),
            )
          ) {
            // This might be a worker, ensure it's CSP headers are valid
            checkWorkerEndpointCSP(
              request.response,
              allowedWorkerCSPs,
              getCurrentOrigin(),
            );
          }
        }
      }
      sendMessageToBackground({
        type: MESSAGE_TYPE.DEBUG,
        log: `Tab is processing ${request.response.url}`,
      });
      ALL_FOUND_SCRIPT_TAGS.add(request.response.url);
      const uninitializedScripts = FOUND_SCRIPTS.get(
        FOUND_SCRIPTS.keys().next().value,
      );
      if (uninitializedScripts) {
        uninitializedScripts.push({
          src: request.response.url,
          otherType: currentFilterType,
        });
      }
      updateCurrentState(STATES.PROCESSING);
    }
  } else if (request.greeting === 'sniffableMimeTypeResource') {
    updateCurrentState(
      STATES.INVALID,
      `Sniffable MIME type resource: ${request.src}`,
    );
  }
});
