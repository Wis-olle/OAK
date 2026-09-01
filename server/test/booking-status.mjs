/*
 * The booking status vocabulary, lifted out of ui/assets/js/oak-api.js.
 *
 * Four pages used to keep their own copy of it; now they all call OAK.bookingStatus(), which
 * means the OAK stub every page test builds has to answer with the same table a browser
 * would. Restating it here would put a fifth copy in the repo and let it drift, so the real
 * declaration is sliced out of the client and evaluated — the same trick the page factories
 * are lifted with. Not a *.test.mjs file, so `node --test test/*.test.mjs` never runs it.
 */
import vm from 'node:vm';
import { readUi } from './lib/read-source.mjs';

const source = readUi('assets/js/oak-api.js');

const from = source.indexOf('var BOOKING_STATUSES = [');
const until = source.indexOf('/* One set of promises');
if (from < 0 || until < from) throw new Error('oak-api.js no longer declares BOOKING_STATUSES');

const context = {};
vm.runInNewContext(
  `${source.slice(from, until)}\nresult = { bookingStatus: bookingStatus, BOOKING_STATUSES: BOOKING_STATUSES };`,
  context,
);

export const bookingStatus = context.result.bookingStatus;
export const BOOKING_STATUSES = context.result.BOOKING_STATUSES;
