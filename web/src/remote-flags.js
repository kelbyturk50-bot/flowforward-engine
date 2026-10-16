// Loads DB-backed flags into the snapshot flagEnabled reads.
// A thrown client or a payload that is not a list fails closed.

import { useEffect, useState } from 'react';
import { api } from './api';
import {
  beginFlagLoad,
  commitFlagLoad,
  currentFlagGeneration,
  failFlagLoad,
  subscribeFeatureFlags,
} from './flags';

export function refreshRemoteFlags() {
  const ticket = beginFlagLoad();
  return api.flags().then((list) => {
    if (!Array.isArray(list)) {
      const error = new Error('Feature flags response was not a list.');
      error.status = 0;
      throw error;
    }
    if (ticket !== currentFlagGeneration()) return list;
    commitFlagLoad(ticket, list);
    return list;
  }).catch((error) => {
    failFlagLoad(ticket, error);
    throw error;
  });
}

export function useLoadFeatureFlags() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    const unsubscribe = subscribeFeatureFlags(() => {
      if (live) setVersion((version) => version + 1);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    refreshRemoteFlags().catch(() => {});
  }, []);
}
