const { supabaseAdmin } = require('../config/supabase');
const { sendEmail } = require('./notifications');

// When an SOS is raised, the parent's trusted contacts who have an email get a
// short message with the private live-location link. SMS is not set up yet, so
// contacts with only a phone number are not messaged (the parent can call them).

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || '';

const loadEmailContacts = async (parentId) => {
  const { data, error } = await supabaseAdmin.from('trusted_contacts').select('name, email').eq('parent_id', parentId).not('email', 'is', null);
  if (error) { console.warn('Trusted contacts not loaded for SOS', error.message); return []; }
  return (data || []).filter((c) => c.email);
};

const sosContactMessage = ({ contactName, parentName, childName, reporterRole }) => {
  const parent = firstName(parentName) || 'A parent';
  const child = firstName(childName) || 'their child';
  const who = reporterRole === 'driver' ? `The KidRide driver taking ${child}` : `${parent}`;
  return {
    title: `SOS on ${child}'s KidRide trip`,
    body: `Hi ${firstName(contactName) || 'there'}, ${who} pressed SOS during ${child}'s ride. ${parent} listed you as a trusted contact. KidRide support has been alerted. Open the link to see where the car is now. If anyone is in immediate danger, call 911.`
  };
};

/**
 * Starts the emails and returns { count, sending }: how many contacts are being
 * emailed (known at once) and the promise of the sends.
 */
const emailTrustedContacts = async ({ ride, liveUrl, reporterRole }) => {
  const contacts = await loadEmailContacts(ride.parent_id);
  if (!contacts.length || !process.env.RESEND_API_KEY) return { count: 0, sending: Promise.resolve() };
  const { data: child } = ride.child_id ? await supabaseAdmin.from('children').select('name').eq('id', ride.child_id).maybeSingle() : { data: null };
  const parentName = ride.parent?.name || '';
  const sending = Promise.all(contacts.map((contact) => {
    const { title, body } = sosContactMessage({ contactName: contact.name, parentName, childName: child?.name, reporterRole });
    return sendEmail(contact.email, title, body, liveUrl, {
      button: 'See live location',
      footer: 'You got this because you are saved as a trusted contact on KidRide. The link stops working once support has handled the alert.'
    });
  })).catch((error) => console.warn('SOS contact email failed', error?.message || error));
  return { count: contacts.length, sending };
};

module.exports = { emailTrustedContacts, sosContactMessage };
