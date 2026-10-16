// Data adapter for the estimate-recovery demo.
// `token` is opaque. This build ignores it and loads one bundled fixture.
// A later API can replace this module without changing the view.
// The fixture import is dynamic so the sample copy stays out of the CRM bundle.

export async function getDemo(token, { company } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Missing demo token');
  }
  const { buildDemo } = await import('./fixture.js');
  return buildDemo({ company });
}
