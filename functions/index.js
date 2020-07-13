const admin = require('firebase-admin')
const functions = require('firebase-functions')
const _ = require('lodash')
const moment = require('moment')
const serviceAccount = require('../key/ck-finances-2-firebase-adminsdk-q5ngf-85a2c3cf4a.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://ck-finances-2.firebaseio.com'
})

exports.addRecurringExpenses = functions.region('europe-west1').pubsub.schedule('every 24 hours').onRun((context) => {
addRecurring(true).then(() => console.log('addRecurringExpenses: Success')).catch(() => console.log('addRecurringExpenses: Error'))
})
exports.addRecurringIncomes = functions.region('europe-west1').pubsub.schedule('every 24 hours').onRun((context) => {
  addRecurring(false).then(() => console.log('addRecurringIncomes: Success')).catch(() => console.log('addRecurringIncomes: Error'))
})

exports.addRecurringExpenses = functions.region('europe-west1').https.onRequest((req, res) => {
  addRecurring(true).then(() => res.sendStatus(200)).catch(() => res.sendStatus(401))
})

const addRecurring = (isExpense) => {
  return new Promise((res, rej) => {
    admin.firestore().collection('Household').get().then((response) => {
      const docs = response.docs
      const promises = []
      for ( let i = 0; i < docs.length; i++ ) {
        const duplicateMonths = {...docs[i].data().months}
        promises.push(new Promise((resolve, reject) => {
          const today = moment().utc(0).startOf('day').valueOf()
          docs[i].ref.collection( isExpense ? 'RecurringExpenses' : 'RecurringIncomes' ).where('timestamp', '<=', today).get().then((response1) => {
            const docs1 = response1.docs
            const promises1 = []
            for ( let j = 0; j < docs1.length; j++ ) {
              promises1.push(new Promise((resolve1, reject1) => {
                const data = docs1[j].data()
                const batch = admin.firestore().batch()
                const newTransaction = {
                  amount: data.amount,
                  category: data.category,
                  membersAmount: data.membersAmount,
                  timestamp: data.timestamp,
                  title: data.title
                }
                const newStartOfMonth = moment(data.timestamp).startOf('month').valueOf().toString()
                let nextTimestamp = data.timestamp
                switch (data.period) {
                  case 0:
                    nextTimestamp = moment(data.timestamp).add(1, 'days').valueOf()
                    break
                  case 1:
                    nextTimestamp = moment(data.timestamp).add(7, 'days').valueOf()
                    break
                  case 2:
                    nextTimestamp = moment(data.timestamp).add(1, 'month').valueOf()
                    break
                  case 3:
                    nextTimestamp = moment(data.timestamp).add(3, 'month').valueOf()
                    break
                  case 4:
                    nextTimestamp = moment(data.timestamp).add(6, 'month').valueOf()
                    break
                  case 5:
                    nextTimestamp = moment(data.timestamp).add(1, 'year').valueOf()
                    break
                  default:
                    break
                }

                _.each(newTransaction.membersAmount, (item, key) => {
                  if ( ! duplicateMonths[newStartOfMonth] ) {
                    duplicateMonths[newStartOfMonth] = { eCounter: 0, iCounter: 0 }
                  }
                  if ( ! duplicateMonths[newStartOfMonth][key] ) {
                    duplicateMonths[newStartOfMonth][key] = {}
                  }
                  if ( ! duplicateMonths[newStartOfMonth][key][newTransaction.category] ) {
                    duplicateMonths[newStartOfMonth][key][newTransaction.category] = { expense: 0, income: 0 }
                  }
                  duplicateMonths[newStartOfMonth] = {
                    ...duplicateMonths[newStartOfMonth],
                    [key]: {
                      ...duplicateMonths[newStartOfMonth][key],
                      [newTransaction.category]: isExpense
                      ? {
                          ...duplicateMonths[newStartOfMonth][key][newTransaction.category],
                          expense: Math.round((duplicateMonths[newStartOfMonth][key][newTransaction.category].expense + item) * 100) / 100
                        }
                      : {
                          ...duplicateMonths[newStartOfMonth][key][newTransaction.category],
                          income: Math.round((duplicateMonths[newStartOfMonth][key][newTransaction.category].income + item) * 100) / 100
                        }
                    }
                  }
                })

                duplicateMonths[newStartOfMonth] = {
                  ...duplicateMonths[newStartOfMonth],
                  eCounter: isExpense ? duplicateMonths[newStartOfMonth].eCounter + 1 : duplicateMonths[newStartOfMonth].eCounter,
                  iCounter: ! isExpense ? duplicateMonths[newStartOfMonth].iCounter + 1 : duplicateMonths[newStartOfMonth].iCounter
                }

                batch.set(
                  admin.firestore().doc('Household/' + docs[i].id),
                  { months: duplicateMonths },
                  { merge: true }
                )

                batch.set(
                  admin.firestore().collection(
                    isExpense
                    ? 'Household/' + docs[i].id + '/Expenses'
                    : 'Household/' + docs[i].id + '/Incomes'
                  ).doc(),
                  {
                    amount: data.amount,
                    category: data.category,
                    membersAmount: data.membersAmount,
                    timestamp: data.timestamp,
                    title: data.title
                  }
                )
                batch.set(
                  docs1[j].ref,
                  {
                    timestamp: nextTimestamp
                  },
                  { merge: true }
                )
                batch.commit().then(() => resolve1()).catch((error) => {
                  console.log('batch: ' + error)
                  reject1()
                })
              }))
            }
            Promise.all(promises1).then(() => {
              resolve()
            }).catch(() => reject())
          })
        }))
      }
      Promise.all(promises).then(() => res()).catch(() => rej())
    }).catch((error) => {
      console.log(error)
      return false
    })
  })
}

exports.inviteToHousehold = functions.region('europe-west1').https.onCall((data, context) => {
  const { email, householdID } = data

  if ( ! context.auth.uid ) {
    return { status: 'error', code: 401, error: 'Not authenticated' }
  }

  const householdRef = admin.firestore().doc('Household/' + householdID)

  return householdRef.get().then((response) => {
    if ( response.exists ) {
      const householdData = response.data()
      return admin.auth().getUserByEmail(email).then((response1) => {
        if ( response1.uid != context.auth.uid ) {
          const userRef = admin.firestore().doc('Users/' + response1.uid)
          return userRef.get().then((response2) => {
            if ( response2.exists ) {
              const userData = response2.data()
              if ( ! userData.householdID ) {
                const batch = admin.firestore().batch()
                batch.set(
                  householdRef,
                  {
                    access: {
                      ...householdData.access,
                      [response1.uid]: {
                        name: userData.name,
                        active: true
                      }
                    }
                  },
                  { merge: true }
                )
                batch.set(
                  userRef,
                  {
                    householdID
                  },
                  { merge: true }
                )
                return batch.commit().then(() => {
                  return { status: 'success', code: 200, error: 'User successfully added to household' }
                }).catch((error3) => {
                  console.log('batch.commit: ' + error3)
                  return { status: 'error', code: 401, error: 'An error has occured, please try again' }
                })
              } else {
                console.log('! userData.householdID:')
                return { status: 'error', code: 401, error: 'User already belongs to a household' }
              }
            } else {
              console.log('response2.exists')
              return { status: 'error', code: 401, error: 'No such user' }
            }
          }).catch((error2) => {
            console.log('userRef.get: ' + error2)
            return { status: 'error', code: 401, error: 'No such user' }
          })
        } else {
          console.log('response1.uid != context.auth.uid')
          return { status: 'error', code: 401, error: 'Cannot invite yourself to household' }
        }
      }).catch((error1) => {
        console.log('getUserByEmail: ' + error1)
        return { status: 'error', code: 401, error: 'No such user' }
      })
    } else {
      console.log('response.exists')
      return { status: 'error', code: 401, error: 'Not authenticated' }
    }
  }).catch((error) => {
    console.log('householdRef: ' + error)
    return { status: 'error', code: 401, error: 'Not authenticated' }
  })
})
