function findNestedValue(source, keys) {
  if (!source || typeof source !== 'object') return '';

  const stack = [source];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        const value = current[key];
        if (value !== undefined && value !== null && value !== '') {
          return value;
        }
      }
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return '';
}

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }

  if (value && typeof value === 'object') {
    if (typeof value.value !== 'undefined') {
      return normalizeValue(value.value);
    }
    if (typeof value.answer !== 'undefined') {
      return normalizeValue(value.answer);
    }
    if (typeof value.text !== 'undefined') {
      return normalizeValue(value.text);
    }
  }

  return value;
}

function parseGoogleFormPayload(payload = {}, query = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const normalizedBody = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, normalizeValue(value)])
  );

  const queryValues = query && typeof query === 'object' ? Object.fromEntries(
    Object.entries(query).map(([key, value]) => [key, normalizeValue(value)])
  ) : {};

  return {
    name: normalizeValue(findNestedValue({ ...normalizedBody, ...queryValues }, ['name', 'playerName', 'fullName', 'player', 'playerNameResponse'])),
    details: normalizeValue(findNestedValue({ ...normalizedBody, ...queryValues }, ['details', 'description', 'bio', 'about', 'profile'])),
    category: normalizeValue(findNestedValue({ ...normalizedBody, ...queryValues }, ['category', 'playerCategory', 'role', 'type'])),
    playedIn: normalizeValue(findNestedValue({ ...normalizedBody, ...queryValues }, ['playedIn', 'team', 'previousTeam', 'club', 'regularTeam'])),
    amount: normalizeValue(findNestedValue({ ...normalizedBody, ...queryValues }, ['amount', 'basePrice', 'price', 'bidAmount'])),
    phone: normalizeValue(findNestedValue({ ...normalizedBody, ...queryValues }, ['phone', 'phoneNumber', 'mobile', 'contact'])),
    image: normalizeValue(findNestedValue({ ...normalizedBody, ...queryValues }, ['image', 'imageUrl', 'photoUrl', 'photo', 'fileUrl', 'attachmentUrl']))
  };
}

module.exports = {
  parseGoogleFormPayload
};
