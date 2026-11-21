import { record } from './site.js';
import { drawPlan } from './plan.js';

const readout = document.getElementById('readout');
Promise.all([drawPlan(document.getElementById('plan'), readout), record()])
  .then(([plan, r]) => {
    const manifestDocuments = r.site.content.split(':').pop().split(',').length;
    const count = document.getElementById('count');
    count.textContent = String(plan.documents + manifestDocuments + 2);
    count.title = `${plan.documents} file chunks, ${manifestDocuments} manifest, the site record and the name`;
  })
  .catch(() => {
    readout.textContent = 'The plan is drawn from the site manifest, which is available when the site is opened through a Dash Sites gateway.';
  });
