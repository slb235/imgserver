"use strict";
const fs = require('fs')
const express = require('express')
const async = require('async')
const sharp = require('sharp')
const compile = require('string-template/compile')
const gm = require('gm').subClass({ imageMagick: true })
const ActionboundStorageClient = require('actionbound-storage-client')

const config = require('../../config')


const storage = new ActionboundStorageClient(config.storage)

const app = express()



Object.keys(config.endPoints).forEach((endPointKey) => {
  const endPoint = config.endPoints[endPointKey]
  /*
  const sourceset = config.sourceSets[endPoint.sourceSet].map((source) => (
    Object.assign(source, { _target: compile(source.target) })
  ))
  */

  const target = config.sourceSets[endPoint.sourceSet]

  app.get(endPointKey, (req, res, next) => {
    let file = target   
    for(const key of Object.keys(req.params)) {
      file = file.replace(`{${key}}`, req.params[key])      
    }
    console.log('request for file', file)
    storage.createReadStream(file)
    .then((imageStream) => {
      if(req.params.format == 'gif') {
        // for gifs we have to go the gm route (to support animated gifs)
        gm(imageStream).size((err, originalSize) => {
          if(err) {
            next(err)
            return
          }
          // get another stream
          async.eachSeries(sourceset, open.bind(req.params), (err) => {
            if(err && err.success) {
              imageStream = err.stream
            }
            else {
              next(new Error('File not found'))
              return
            }
            let magick = gm(imageStream).noProfile()
            let size = [null, null], needResize = false
            endPoint.operations.forEach((operation) => {
              switch(operation.type) {
                case 'rotate':
                  magick = magick.autoOrient()
                  break
                case 'resize':
                  size = operation.size
                  needResize = true
                  break
                case 'crop':
                  needResize = false
                  let targetRatio = size[0] / size[1]
                  let originalRatio = originalSize.width / originalSize.height
                  let cropX, cropY, cropWidth, cropHeight
                  if(originalRatio > targetRatio) {
                    cropWidth = originalSize.height * targetRatio
                    cropHeight = originalSize.height
                    cropX = (originalSize.width - cropWidth) / 2
                    cropY = 0
                  }
                  else {
                    if(originalRatio < targetRatio) {
                      cropWidth = originalSize.width
                      cropHeight = originalSize.width / targetRatio
                      cropX = 0
                      cropY = (originalSize.height - cropHeight) / 2
                    }
                    else {
                      cropWidth = 0
                      cropHeight = 0
                      cropX = 0
                      cropY = 0
                    }
                  }
                  magick = magick.crop(cropWidth, cropHeight, cropX, cropY).resize(size[0], size[1]).out('+repage')
                  break
              }
            })
            if(needResize) {
              if((originalSize.width > size[0] && size[0]) || (originalSize.height > size[1] && size[1])) {
                magick = magick.resize(size[0], size[1])
              }
            }
            res.set('Content-Type', 'image/gif')
            magick.stream((err, stdout, stderr) => {
              if(err) {
                next(err)
                return
              }
              stdout.pipe(res)
              stderr.on('error', next)
            })
          })
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
              if(operation.withoutEnlargement) {
                op = op.withoutEnlargement()
              }
              break
            case 'withoutEnlargement':
              op = op.withoutEnlargement()
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
    .catch((error) => {
      console.log(error)
      next(new Error('File not found'))
      return
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
