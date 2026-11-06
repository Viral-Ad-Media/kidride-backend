const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');

// A parent's trusted contacts on the Safety page. Those with an email get the
// live-location link when an SOS is raised on one of the parent's rides.
const router = express.Router();

const MAX_CONTACTS = 5;
// Digits with optional +, spaces, dashes, dots and brackets; 7-15 digits in total.
const PHONE_PATTERN = /^\+?[\d\s().-]{7,20}$/;

const requireParent = (req, res, next) => (req.user.role === 'parent' ? next() : res.status(403).json({ message: 'Parent account required' }));

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const formatContact = (row) => ({ id: row.id, name: row.name, phone: row.phone, email: row.email || null, relationship: row.relationship || null, createdAt: row.created_at });

const listContacts = async (parentId) => {
  const { data, error } = await supabaseAdmin
    .from('trusted_contacts')
    .select('id, name, phone, email, relationship, created_at')
    .eq('parent_id', parentId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(formatContact);
};

router.get('/', protect, requireParent, async (req, res) => {
  try {
    return res.json({ contacts: await listContacts(req.user.id) });
  } catch (error) {
    return sendError(res, error, 'Unable to load trusted contacts');
  }
});

router.post('/', protect, requireParent, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
  const relationship = typeof req.body.relationship === 'string' ? req.body.relationship.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const digits = phone.replace(/\D/g, '').length;
  if (!name || name.length > 100) return res.status(400).json({ message: 'Enter the contact\'s name (up to 100 characters).' });
  if (!PHONE_PATTERN.test(phone) || digits < 7 || digits > 15) return res.status(400).json({ message: 'Enter a valid phone number, e.g. +44 7700 900123.' });
  if (email && (email.length > 254 || !EMAIL_PATTERN.test(email))) return res.status(400).json({ message: 'Enter a valid email, or leave it empty.' });
  if (relationship.length > 50) return res.status(400).json({ message: 'Keep the relationship under 50 characters.' });
  try {
    const existing = await listContacts(req.user.id);
    if (existing.length >= MAX_CONTACTS) return res.status(409).json({ message: `You can save up to ${MAX_CONTACTS} trusted contacts. Remove one to add another.` });
    const { error } = await supabaseAdmin.from('trusted_contacts').insert({ parent_id: req.user.id, name, phone, email: email || null, relationship: relationship || null });
    if (error) throw error;
    return res.status(201).json({ contacts: await listContacts(req.user.id) });
  } catch (error) {
    return sendError(res, error, 'Unable to save trusted contact');
  }
});

router.delete('/:id', protect, requireParent, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('trusted_contacts').delete().eq('id', req.params.id).eq('parent_id', req.user.id).select('id');
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ message: 'Contact not found' });
    return res.json({ contacts: await listContacts(req.user.id) });
  } catch (error) {
    return sendError(res, error, 'Unable to remove trusted contact');
  }
});

module.exports = router;
