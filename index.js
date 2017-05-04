"use strict";
const express = require('express')
const async = require('async')
const sharp = require('sharp')
const compile = require('string-template/compile')
const gs = require('@google-cloud/storage')

const config = require('./config')

const app = express()

const storage = gs(config.googleStorage)

// check if file exists in source, params are bound to this
function check(source, callback) {
  switch(source.type) {
    case "googleStorage":
      const file = source._bucket.file(source._target(this))
      file.exists(callback)
      break;
    default:
      callback("source type unkown")
  }
}

// get stream for file, params are bound to this
function open(source) {
  switch(source.type) {
    case "googleStorage":
      return source._bucket.file(source._target(this)).createReadStream()
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
    async.detectSeries(sourceset, check.bind(req.params), (err, source) => {
      if(err) {
        next(err)
        return
      }
      if(source) {

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

        const imageStream = open.bind(req.params)(source)
        let contentType
        switch(req.params.format) {
          case 'jpg':
          case 'jpeg':
            op = op.jpeg(endPoint.outputOptions && endPoint.outputOptions.jpeg ? endPoint.outputOptions.jpeg : config.outputOptions.jpeg)
            contentType = 'image/jpeg'
            break;
          case 'png':
            op = op.png(endPoint.outputOptions && endPoint.outputOptions.png ? endPoint.outputOptions.png : config.outputOptions.png)
            contentType = 'image/png'
            break;
          case 'webp':
            op = op.webp(endPoint.outputOptions && endPoint.outputOptions.webp ? endPoint.outputOptions.webp : config.outputOptions.webp)
            contentType = 'image/webp'
            break;
          default:
            next('uknown format')
        }
        op.on('error', (err) => {
          next(err)
        })
        res.set('Content-Type', contentType)
        imageStream.pipe(op).pipe(res)
      }
      else {
        next('file not found')
      }
    })
  })
})

app.listen(config.port || 3000)
