import { defineSecret } from 'firebase-functions/params'

// Bind the secret to the API function; only data routes read its value.
// The health route shares this function but never includes the value in its response.
export const publicDataServiceKey = defineSecret('PUBLIC_DATA_SERVICE_KEY')
