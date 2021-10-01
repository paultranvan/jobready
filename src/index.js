const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  cozyClient,
  saveFiles
} = require('cozy-konnector-libs')
const KJUR = require('jsrsasign')
const request = requestFactory({
  json: true
})

const VENDOR = 'Jobready'
const baseUrl = 'https://visionstrust.com/v1'
const serviceKey =
  'SlQ03OMYYo3MAGSdM2UqUuVEGf2Je81N63tUa81D8LgK8CAbxPoSELxmLPtpLGvXdp8ckPAvs6BtuHTeNTjPcoS1SwwumLZjjRd4'
const secretKey = 'LjldXJAX6MJm2qi'
const client = cozyClient.new

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Start konnector')

  try {
    const email = fields.login
    const url = process.env.COZY_URL.replace(/(^\w+:|^)\/\//, '')

    const cozyFields = JSON.parse(process.env.COZY_FIELDS || '{}')
    const account = cozyFields.account
    const payload = JSON.parse(process.env.COZY_PAYLOAD || '{}')

    log('debug', `Payload: ${JSON.stringify(payload)}`)

    if (payload.serviceExportUrl && payload.signedConsent) {
      log('info', `Start consent import`)
      const consent = await consentImport(account, payload)
      log('debug', `Consent: ${JSON.stringify(consent)}`)
      return
    } else if (payload.signedConsent && payload.data && payload.user) {
      log('info', `Start data import`)
      const data = await importData(fields, payload)
      log('debug', `Import data: ${JSON.stringify(data)}`)
      return
    }

    log('info', `Start consent exchange`)

    const token = generateJWT(serviceKey, secretKey)

    log('info', 'Get user')
    const user = await getOrCreateUser(token, { email, userServiceId: url })
    if (!user) {
      throw new Error('No user found')
    }

    log('info', 'Get purposes')
    const purposes = await getPurposes(token)
    if (!purposes || purposes.length < 1) {
      throw new Error('No purpose found')
    }
    const purposeId = purposes[0].id

    log('info', 'Get import info')
    const popup = await popupImport(token, {
      purpose: purposeId,
      emailImport: email
    })

    const datatypes = popup.datatypes
      .filter(type => type.serviceExport === VENDOR)
      .map(type => {
        return { ...type, checked: true }
      })
    if (!datatypes || datatypes.length < 1) {
      throw new Error('No datatype')
    }

    const emailExport = popup.emailsExport.find(type => type.service === VENDOR)
    if (!emailExport) {
      throw new Error('No email export')
    }

    const webhook = await getOrCreateWebhook(fields, account)
    const importUrl = webhook.links.webhook
    log('debug', `Webhook available on ${importUrl}`)

    log('info', 'Create import consent')
    const consent = await createConsent(token, {
      datatypes,
      emailImport: user.email,
      emailExport: emailExport.email,
      serviceExport: VENDOR,
      purpose: purposeId,
      userKey: user.userKey
    })
    log('debug', `Consent: ${JSON.stringify(consent)}`)
    log('info', 'Done!')
  } catch (err) {
    log('error', err && err.message)
    throw new Error(errors.VENDOR_DOWN)
  }
}

const getAccountWebhook = async accountId => {
  const selector = {
    worker: 'konnector',
    type: '@webhook'
  }
  const webhooks = await client.collection('io.cozy.triggers').find(selector)
  return webhooks.data.find(webhook => {
    const msg = webhook.attributes.message
    return msg && msg.account === accountId
  })
}

const getFolderId = async path => {
  const file = await client.collection('io.cozy.files').statByPath(path)
  return file.data._id
}

const getOrCreateWebhook = async (fields, accountId) => {
  const accountWebhook = await getAccountWebhook(accountId)
  if (!accountWebhook) {
    const targetDirId = await getFolderId(fields.folderPath)
    const newWebhook = await client.collection('io.cozy.triggers').create({
      worker: 'konnector',
      type: '@webhook',
      message: {
        account: accountId,
        konnector: VENDOR.toLowerCase(),
        folder_to_save: targetDirId
      }
    })
    return newWebhook.data
  }
  return accountWebhook
}

const getOrCreateUser = async (token, params) => {
  const { email, userServiceId } = params
  if (!email || !userServiceId) {
    throw new Error('Missing parameters')
  }
  let user
  try {
    user = await request.get(`${baseUrl}/users/${email}`, {
      auth: {
        bearer: token
      }
    })
    if (user) {
      return user
    }
  } catch (err) {
    if (err.statusCode == 400) {
      return request.post(`${baseUrl}/users`, {
        body: { email, userServiceId },
        auth: {
          bearer: token
        }
      })
    }
    throw new Error(err)
  }
}

const getPurposes = async token => {
  return request.get(`${baseUrl}/purposes/list`, {
    auth: {
      bearer: token
    }
  })
}

const popupImport = async (token, params) => {
  const { purpose, emailImport } = params
  if (!purpose || !emailImport) {
    throw new Error('Missing parameters')
  }
  return request.post(`${baseUrl}/popups/import`, {
    body: { purpose, emailImport },
    auth: {
      bearer: token
    }
  })
}

const createConsent = async (token, params) => {
  if (
    !params.datatypes ||
    !params.emailImport ||
    !params.emailExport ||
    !params.serviceExport ||
    !params.purpose ||
    !params.userKey
  ) {
    throw new Error('Missing parameters')
  }
  return request.post(`${baseUrl}/consents/exchange/import`, {
    body: params,
    auth: {
      bearer: token
    }
  })
}

const consentImport = async (accountId, params) => {
  const { serviceExportUrl, signedConsent } = params
  if (!serviceExportUrl || !signedConsent) {
    throw new Error('Missing parameters')
  }
  const webhook = await getAccountWebhook(accountId)
  const dataImportUrl = webhook.links.webhook
  return request.post(`${serviceExportUrl}`, {
    body: {
      signedConsent,
      dataImportUrl
    }
  })
}

const importData = async (fields, params) => {
  const { data } = params
  if (!data) {
    throw new Error('Missing parameters')
  }
  const file = {
    filestream: JSON.stringify(data),
    filename: `${VENDOR}.txt`,
    shouldReplaceFile: () => true
  }
  return saveFiles([file], fields)
}

const generateJWT = (serviceKey, secretKey) => {
  var oHeader = { alg: 'HS256', typ: 'JWT' }
  var payload = {}
  var tNow = KJUR.jws.IntDate.get('now')
  payload.iat = tNow
  payload = {
    serviceKey,
    iat: tNow,
    exp: tNow + 5 * 60
  }
  var sHeader = JSON.stringify(oHeader)
  var sPayload = JSON.stringify(payload)
  var sJWT = KJUR.jws.JWS.sign('HS256', sHeader, sPayload, secretKey)
  return sJWT
}
