/*eslint no-console: "off"*/

const mqttWildcard = require('mqtt-wildcard')
const mqtt = require('mqtt')
const _ = require('lodash')
const AWS = require('aws-sdk')
const request = require('request-promise-native')
const uuid = require('uuid/v4')

const {AWS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY, AWS_IOT_ENDPOINT_HOST, AWS_REGION, USER, PASS, MQTT, CHRIS_TELEGRAM_ID, HANNAH_TELEGRAM_ID, GROUP_TELEGRAM_ID} = process.env

const AWSMqtt = require("aws-mqtt-client").default

const awsMqttClient = new AWSMqtt({
  accessKeyId: AWS_ACCESS_KEY,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
  endpointAddress: AWS_IOT_ENDPOINT_HOST,
  region: AWS_REGION,

})

const iotdata = new AWS.IotData({
  endpoint: AWS_IOT_ENDPOINT_HOST,
  accessKeyId: AWS_ACCESS_KEY,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
  region: AWS_REGION,
})

const s3 = new AWS.S3({
  accessKeyId: AWS_ACCESS_KEY,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
  region: AWS_REGION
})

const client = mqtt.connect(MQTT, {
  username: USER,
  password: PASS,
  clean: false,
  clientId: `rules_engine`
})

const topics = [
  "owntracks/+/+/event",
  "presence/home/+"
]

const awsTopics = [
  "domoticz/out",
  '$aws/things/alarm_status/shadow/update/documents',
  '$aws/things/alarm_zone_7/shadow/update/documents',
  '$aws/things/alarm_zone_4/shadow/get/accepted',
  `notify/out/${CHRIS_TELEGRAM_ID}`,
  `notify/out/${HANNAH_TELEGRAM_ID}`
]

client.on('connect', () => client.subscribe(topics,
  {qos: 2},
  (err, granted) => console.log("mqtt", err, granted)
))

awsMqttClient.on('connect', () => awsMqttClient.subscribe(awsTopics,
  {qos: 1},
  (err, granted) => console.log("aws", err, granted)
))

let current_alarm_state
let current_alarm_full_status

client.on('message', function (topic, message) {
  message = message_parser(message)

  let t
  if ((t = mqttWildcard(topic, 'owntracks/+/+/event')) && t !== null) {
    let device_map = {cnsiphone: "Chris", hnsiphone: "Hannah"}
    if (message._type === "transition" && message.desc === "Home" && device_map[t[1]]) {
      client.publish(`presence/${message.desc.toLowerCase()}/${device_map[t[1]]}`, message.event === "enter" ? "true" : "false", {retain: true})
      client.publish(`presence/${message.desc.toLowerCase()}/${message.event}`, device_map[t[1]])
    }
  }

  // someone just got home
  if (topic === 'presence/home/enter') {
    console.log(`${message} just got home`)
    say_helper("kitchen", `${message} just arrived`)
    notify_helper(TL_MAP[message.toLowerCase()], "You just got back, I've tried to disarm the alarm, you should get another message to confirm this has been successful")
    awsMqttClient.publish(`$aws/things/alarm_status/shadow/update`, JSON.stringify({state: {desired: {state: "disarm"}}}))
  }

  // if people leave without setting an alarm
  if (topic === 'presence/home/leave' && current_alarm_state === "Disarm") {
    console.log(`${message} left with disarmed alarm`)
    notify_helper(TL_MAP[message.toLowerCase()], "You have left home but not set the alarm")
  }

  // if people arrive and the alarm is disarmed let them know
  if (topic === 'presence/home/arrive' && current_alarm_state === "Disarm") {
    console.log(`${message} arrived to a disarmed alarm`)
    notify_helper(TL_MAP[message.toLowerCase()], "You have arrived home the alarm is NOT armed")
  }

  // if people leave
  if (topic === 'presence/home/leave')
    say_helper("kitchen", `${message} just left`)

})

awsMqttClient.on('message', function (topic, message) {
  message = message_parser(message)

  if (topic === '$aws/things/alarm_status/shadow/update/documents') {
    current_alarm_state = message.current.state.reported.state
    current_alarm_full_status = message.current.state.reported
    // alarm state has changed
    if (message.previous.state.reported.state !== message.current.state.reported.state) {
      console.log(`Alarm state changed to ${message.current.state.reported.state}, it was ${message.previous.state.reported.state}`)
      notify_helper(GROUP_TELEGRAM_ID, `Alarm state changed to ${message.current.state.reported.state}, it was ${message.previous.state.reported.state}`)

      if (message.current.state.reported.state === "Disarm") {
        say_helper("kitchen", `Alarm is now disarmed`)
        domoticz_helper(3, "Off")
        domoticz_helper(51, "On")
      }
    }
  }
  if (topic === '$aws/things/alarm_zone_7/shadow/update/documents' && is_alarm_device_open(message.previous.state.reported) !== is_alarm_device_open(message.current.state.reported)) {
    console.log(JSON.stringify(message))
    console.log("garage door state changed, announcing alarm status")
    say_helper("garage", `Alarm is currently ${current_alarm_state}`)
  }

  // react to chatbot commands
  if ((t = mqttWildcard(topic, 'notify/out/+')) && t !== null) {
    // send acknowledgement back to user
    notify_helper(t[0].toString(), "ACK", null, true)

    message = message.toLowerCase()
    console.log(`Telegram user ${t[0]} just sent:"${message}"`)

    if (message === messages.unlock_door.toLowerCase())
      domoticz_helper(3, "Off")

    if (message === messages.doorbell_off.toLowerCase())
      domoticz_helper(195, "Off")

    if (message === messages.doorbell_on.toLowerCase())
      domoticz_helper(195, "On")

    if (message === messages.arm_alarm_home.toLowerCase()) {
      reply_with_alarm_status(t[0].toString())
      awsMqttClient.publish(`$aws/things/alarm_status/shadow/update`, JSON.stringify({state: {desired: {state: "arm_home"}}}))
    }

    if (message === messages.arm_alarm_away.toLowerCase()) {
      reply_with_alarm_status(t[0].toString())
      awsMqttClient.publish(`$aws/things/alarm_status/shadow/update`, JSON.stringify({state: {desired: {state: "arm_away"}}}))
    }

    if (message === messages.disarm_alarm.toLowerCase())
      awsMqttClient.publish(`$aws/things/alarm_status/shadow/update`, JSON.stringify({state: {desired: {state: "disarm"}}}))

    if (message.startsWith("say")) {
      let split_message = /say\s(\w+)(.*)/gi.exec(message)
      say_helper(split_message[1], split_message[2])
    }

    if (message === messages.start.toLowerCase())
      notify_helper(t[0], `You can do these things`, messages)

    if (message === messages.cam_driveway.toLowerCase())
      send_camera_to('camera_external_driveway', t[0])

    if (message === messages.cam_garden.toLowerCase())
      send_camera_to('camera_external_garden', t[0])

  }

  if (topic === "domoticz/out")
    client.publish(`zwave/${message.stype.toLowerCase()}/${message.idx}`, JSON.stringify(message), {retain: true})

  // someone at the door
  if (topic === "domoticz/out" && message.stype === "Switch" && message.idx === 155 && message.nvalue === 1) {
    console.log("door bell!")

    if (current_alarm_state !== "Away") {
      _.times(4, () => domoticz_helper(79, "Toggle"))
      say_helper("kitchen", "Someone at the door")
    }

    notify_helper(GROUP_TELEGRAM_ID, `Someone at the door`, [messages.unlock_door])

    send_camera_to('camera_external_driveway', GROUP_TELEGRAM_ID)

  }

  // zwave low battery alert
  if (topic === "domoticz/out" && message.Battery && message.Battery < 15)
    notify_helper(CHRIS_TELEGRAM_ID, `zwave device ${message.idx} ${message.name} is low on battery`)

})

const send_camera_to = (camera, who) => {
  console.log("fff")
  let inst_uuid = uuid()
  return iotdata.getThingShadow({thingName: camera}).promise()
    .then(thing => JSON.parse(thing.payload).state.reported.jpg)

    .then(camera_url => request({uri: camera_url, encoding: null}))
    .then(body => s3.putObject({
      Body: body,
      Key: `${inst_uuid}.jpg`,
      ContentType: "image/jpeg",
      ACL: "public-read",
      Bucket: 'me.cns.p.cams'
    }).promise())
    // .then(() => s3.getSignedUrl('getObject', {Bucket: 'me.cns.p.cams', Key: `${inst_uuid}.jpg`}))
    .then(() => notify_helper(who, null, null, true, `https://s3.eu-west-2.amazonaws.com/me.cns.p.cams/${inst_uuid}.jpg`))
}

const reply_with_alarm_status = who => notify_helper(who, `Alarm is currently${current_alarm_full_status.ready_status ? " " : " not "}ready to arm`, null, true)

const is_alarm_device_open = device => {
  if (current_alarm_full_status && current_alarm_full_status.ready_status === true) {
    return false
  }
  return (device.troubles && device.troubles.includes("OPENED"))
}

const messages = {
  start: "/start",
  unlock_door: "Unlock the door",
  arm_alarm_home: "Arm alarm home",
  arm_alarm_away: "Arm alarm away",
  disarm_alarm: "Disarm alarm",
  doorbell_off: "Doorbell off",
  doorbell_on: "Doorbell on",
  cam_driveway: "Get driveway camera",
  cam_garden: "Get garden camera"
}

const TL_MAP = {
  chris: CHRIS_TELEGRAM_ID,
  hannah: HANNAH_TELEGRAM_ID
}

const message_parser = message => {
  try {
    return JSON.parse(message.toString())
  }
  catch (e) {
    return message.toString()
  }
}

const lights_helper = (light, state) => client.publish(`lifx-lights/${light}`, state)

const notify_helper = (who, message, actions = null, disableNotification = false, image = null) =>
  awsMqttClient.publish(`notify/in/${who}`, JSON.stringify({
    disableNotification: disableNotification,
    message: message,
    image: image,
    buttons: actions ? _.map(actions, action => {
      return {title: action, value: action}
    }) : null
  }))

const domoticz_helper = (idx, state) =>
  awsMqttClient.publish('domoticz/in', JSON.stringify({
    command: "switchlight",
    idx: idx,
    switchcmd: state
  }), {qos: 0})

const say_helper = (where, what) =>
  awsMqttClient.publish(`sonos/say/${where}`, JSON.stringify([what, getSayVolume()]), {qos: 0})

const getSayVolume = () => _.inRange(new Date().getHours(), 6, 18) ? 40 : 15

function clean_exit() {
  console.log("Closing connection (clean)")
  client.end(false, () =>
    process.exit(0))
}

function unclean_exit() {
  console.log("Closing connection (unclean)")
  client.end(false, () =>
    process.exit(1))
}

process.stdin.resume()
process.on('exit', clean_exit)
process.on('SIGINT', clean_exit)
process.on('unclean_exit', clean_exit)

client.on('connect', () => console.log("mqtt connected"))
client.on('error', (error) => console.error("mqtt", error))
client.on('close', () => console.error("mqtt connection close"))
client.on('offline', () => console.log("mqtt offline"))

awsMqttClient.on('connect', () => console.log("aws connected"))
awsMqttClient.on('error', (error) => console.error("aws", error))
awsMqttClient.on('close', () => console.error("aws connection close"))
awsMqttClient.on('offline', () => console.log("aws offline"))