/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {MESSAGE_TYPE, Origin, State} from '../config';
import {RawManifestOtherHashes} from '../contentUtils';

export type MessagePayload =
  | {
      type: typeof MESSAGE_TYPE.LOAD_MANIFEST;
      origin: Origin;
      rootHash: string;
      otherHashes: RawManifestOtherHashes;
      leaves: Array<string>;
      version: string;
      workaround: string;
    }
  | {
      type: typeof MESSAGE_TYPE.RAW_JS;
      rawjs: string;
      origin: Origin;
      version: string;
    }
  | {
      type: typeof MESSAGE_TYPE.DEBUG;
      log: string;
    }
  | {
      type: typeof MESSAGE_TYPE.GET_DEBUG;
      tabId: number;
    }
  | {
      type: typeof MESSAGE_TYPE.STATE_UPDATED;
      tabId: number;
      state: State;
    }
  | {
      type: typeof MESSAGE_TYPE.UPDATE_STATE;
      state: State;
      origin: Origin;
    }
  | {
      type: typeof MESSAGE_TYPE.CONTENT_SCRIPT_START;
      origin: Origin;
    }
  | {
      type: typeof MESSAGE_TYPE.UPDATED_CACHED_SCRIPT_URLS;
      url: string;
    };

export type MessageResponse = {
  valid?: boolean;
  success?: boolean;
  debugList?: Array<string>;
  reason?: string;
  hash?: string;
  cspHeader?: string;
  cspReportHeader?: string;
};