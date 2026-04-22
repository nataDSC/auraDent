export type RedactionEntityType =
  | 'patient_name'
  | 'ssn'
  | 'phone'
  | 'email'
  | 'date_of_birth'
  | 'address';

export type RedactionMatch = {
  entityType: RedactionEntityType;
  original: string;
  placeholder: string;
};

export type RedactionResult = {
  text: string;
  matches: RedactionMatch[];
};

type RedactionRule = {
  entityType: RedactionEntityType;
  placeholder: string;
  pattern: RegExp;
};

const REDACTION_RULES: RedactionRule[] = [
  {
    entityType: 'ssn',
    placeholder: '[SSN]',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    entityType: 'phone',
    placeholder: '[PHONE]',
    pattern: /(?<!\w)(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g,
  },
  {
    entityType: 'email',
    placeholder: '[EMAIL]',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  {
    entityType: 'date_of_birth',
    placeholder: '[DOB]',
    pattern:
      /\b(?:dob|date of birth)\s*(?:is|:)?\s*(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|[A-Za-z]+ \d{1,2}, \d{4})\b/gi,
  },
  {
    entityType: 'address',
    placeholder: '[ADDRESS]',
    pattern:
      /\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct)\b/gi,
  },
  {
    entityType: 'patient_name',
    placeholder: '[PATIENT_NAME]',
    pattern: /\b(?:patient|pt)(?:'s)?\s+(?:name\s+is\s+|is\s+)?([A-Za-z]+(?:\s+[A-Za-z]+){1,2})\b/gi,
  },
];

export function redactTranscriptPII(text: string): RedactionResult {
  let redactedText = text;
  const matches: RedactionMatch[] = [];

  for (const rule of REDACTION_RULES) {
    redactedText = redactedText.replace(rule.pattern, (match, capturedName?: string) => {
      const original = rule.entityType === 'patient_name' && capturedName ? capturedName : match;
      matches.push({
        entityType: rule.entityType,
        original,
        placeholder: rule.placeholder,
      });

      if (rule.entityType === 'patient_name' && capturedName) {
        return match.replace(capturedName, rule.placeholder);
      }

      return rule.placeholder;
    });
  }

  redactedText = redactLoosePhoneSequence(redactedText, matches);

  return {
    text: redactedText,
    matches,
  };
}

function redactLoosePhoneSequence(text: string, matches: RedactionMatch[]) {
  return text.replace(/\b((?:phone(?:\s+number)?|number)\b[\s,:-]*)(\d(?:[\d\s().-]{5,20}\d))\b/gi, (match, prefix: string, numericSequence: string) => {
    const digitCount = numericSequence.replace(/\D/g, '').length;
    if (digitCount < 7 || digitCount > 11) {
      return match;
    }

    matches.push({
      entityType: 'phone',
      original: numericSequence,
      placeholder: '[PHONE]',
    });

    return `${prefix}[PHONE]`;
  });
}
