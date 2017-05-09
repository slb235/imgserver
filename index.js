"use strict";
const fs = require('fs')
const express = require('express')
const async = require('async')
const sharp = require('sharp')
const compile = require('string-template/compile')
const gs = require('@google-cloud/storage')
const gm = require('gm').subClass({ imageMagick: true })

const config = require('../../config')

const app = express()

const storage = gs(config.googleStorage)

// open stream for file misusing error as return value
function open(source, callback) {
  switch(source.type) {
    case "file":
      const stream = fs.createReadStream(source._target(this))
      stream.on('error', (err) => {
        callback()
      })
      stream.on('open', () => {
        callback({ success: true, stream })
      })
      break
    case "googleStorage":
      const file = source._bucket.file(source._target(this))
      file.exists((err, exists) => {
        if(exists && !err) {
          callback({ success: true, stream: file.createReadStream() })
        }
        else {
          callback()
        }
      })
      break
  }
}

// initialize sourceset storage if needed (only google storage at the moment)
Object.keys(config.sourceSets).forEach((set) => {
  config.sourceSets[set] = config.sourceSets[set].map((source) => {
    if(source.type == "googleStorage") {
      return Object.assign(source, { _bucket: storage.bucket(source.bucket) })
    }
    else
      return source
  })
})

Object.keys(config.endPoints).forEach((endPointKey) => {
  const endPoint = config.endPoints[endPointKey]
  const sourceset = config.sourceSets[endPoint.sourceSet].map((source) => (
    Object.assign(source, { _target: compile(source.target) })
  ))

  app.get(endPointKey, (req, res, next) => {
    async.eachSeries(sourceset, open.bind(req.params), (err) => {
      let imageStream
      if(err && err.success) {
        imageStream = err.stream
      }
      else {
        next(new Error('File not found'))
        return
      }
      if(req.params.format == 'gif') {
        // for gifs we have to go the gm route (to support animated gifs)
        let magick = gm(imageStream).noProfile()
        let size = [null, null]
        endPoint.operations.forEach((operation) => {
          switch(operation.type) {
            case 'rotate':
              magick = magick.autoOrient()
              break
            case 'resize':
              size = operation.size;
              magick = magick.resize(operation.size[0], operation.size[1], '^')
              break
            case 'crop':
              magick = magick.crop(size[0], size[1])
              break
          }
        })
        res.set('Content-Type', 'image/gif')
        magick.stream((err, stdout, stderr) => {
          if(err) {
            next(err)
            return
          }
          stdout.pipe(res)
          stderr.on('error', next)
        })
      }
      else {
        let op = sharp()
        endPoint.operations.forEach((operation) => {
          switch(operation.type) {
            case 'rotate':
              op = op.rotate()
              break
            case 'resize':
              op = op.resize(operation.size[0], operation.size[1])
              break
            case 'crop':
              switch(operation.strategy) {
                case 'attention':
                  op = op.crop(sharp.strategy.attention)
                  break
                default:
                  op = op.crop(sharp.gravity.centre)
              }
              break
            case 'blur':
              op = op.blur(20)
              break
            case 'overlay':
              op = op.overlayWith(new Buffer(operation.image), { gravity: sharp.gravity.center })
              break
            case 'negate':
              op = op.negate()
              break
            default:
              throw new Error('Unsupportet operation: ' + operation.type)
          }
        })
        let contentType
        switch(req.params.format) {
          case 'png':
            op = op.png(endPoint.outputOptions && endPoint.outputOptions.png ? endPoint.outputOptions.png : config.outputOptions.png)
            contentType = 'image/png'
            break
          case 'webp':
            op = op.webp(endPoint.outputOptions && endPoint.outputOptions.webp ? endPoint.outputOptions.webp : config.outputOptions.webp)
            contentType = 'image/webp'
            break
          case 'jpg':
          case 'jpeg':
          default:
            op = op.jpeg(endPoint.outputOptions && endPoint.outputOptions.jpeg ? endPoint.outputOptions.jpeg : config.outputOptions.jpeg)
            contentType = 'image/jpeg'
        }
        op.on('error', (err) => {
          next(err)
        })
        res.set('Content-Type', contentType)
        imageStream.on('error', (err) => {
          next(err)
        })
        imageStream.pipe(op).pipe(res)
      }
    })
  })
})

app.use((err, req, res, next) => {
  res.status(404).send('File not found')
})

// pm2 downtime free support support
process.on('SIGINT', () => {
  process.exit(0)
})

app.listen(config.listen.port, config.listen.host, () => {
  if('send' in process) {
    process.send('ready')
  }
})
