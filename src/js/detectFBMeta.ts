/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {ORIGIN_TYPE} from './config';
import {startFor} from './contentUtils.js';

// Pathnames that do not currently have messaging enabled and are not BT
// compliant/
// NOTE: All pathnames checked against this list will be surrounded by '/'
const EXCLUDED_PATHNAMES: Array<RegExp> = [
  /**
   * Like plugin
   */
  // e.g. /v2.5/plugins/like.php
  /\/v[\d.]+\/plugins\/like.php\/.*$/,

  /**
   * Page embed plugin
   */
  // e.g. /v2.5/plugins/page.php
  /\/v[\d.]+\/plugins\/page.php\/.*$/,
];

startFor(
  ORIGIN_TYPE.FACEBOOK,
  Object.freeze({
    checkLoggedInFromCookie: true,
    excludedPathnames: EXCLUDED_PATHNAMES,
  }),
);
