import test from 'node:test';
import assert from 'node:assert/strict';
import { redactTranscriptPII } from './redaction';

test('redactTranscriptPII redacts possessive patient-name phrasing', () => {
  const result = redactTranscriptPII("Patient's James Brown. Has four millimeter pockets on tooth 14.");

  assert.equal(result.text, "Patient's [PATIENT_NAME]. Has four millimeter pockets on tooth 14.");
  assert.deepEqual(
    result.matches.map((match) => match.entityType),
    ['patient_name'],
  );
});

test('redactTranscriptPII redacts contextual loose phone numbers after number phrasing', () => {
  const result = redactTranscriptPII('Patient [PATIENT_NAME] number, 4155 551212. Has four millimeter pockets on tooth 14.');

  assert.equal(result.text, 'Patient [PATIENT_NAME] number, [PHONE]. Has four millimeter pockets on tooth 14.');
  assert.deepEqual(
    result.matches.map((match) => match.entityType),
    ['phone'],
  );
});

test('redactTranscriptPII preserves incomplete numeric fragments that are too short to be phone numbers', () => {
  const result = redactTranscriptPII('Patient number, 4155. Has three millimeter pockets on tooth 14.');

  assert.equal(result.text, 'Patient number, 4155. Has three millimeter pockets on tooth 14.');
  assert.equal(result.matches.length, 0);
});

test('redactTranscriptPII redacts multiple identifier types in one utterance', () => {
  const result = redactTranscriptPII(
    'Patient name is Jane Smith, dob 01/02/1980, email jane@example.com, ssn 123-45-6789.',
  );

  assert.equal(
    result.text,
    'Patient name is [PATIENT_NAME], [DOB], email [EMAIL], ssn [SSN].',
  );
  assert.deepEqual(
    result.matches.map((match) => match.entityType),
    ['ssn', 'email', 'date_of_birth', 'patient_name'],
  );
});
