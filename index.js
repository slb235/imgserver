"use strict";
const express = require('express')
const sharp = require('sharp')
const gifResize = require('actionbound-gif-resize-stream')
const ActionboundStorageClient = require('actionbound-storage-client')
const sizeOf = require('image-size')

const config = require('./config/config')

const storage = new ActionboundStorageClient(config.storage)

const app = express()

async function getStreamImageSize(stream) {
	const chunks = []
	for await (const chunk of stream) {
		chunks.push(chunk)
		try {
			return sizeOf(Buffer.concat(chunks));
		} catch (error) {/* Not ready yet */}
	}

	return sizeOf(Buffer.concat(chunks));
}

app.get('/health', (req, res) => {
  res.end('good')
})

Object.keys(config.endPoints).forEach((endPointKey) => {
  const endPoint = config.endPoints[endPointKey]
  const target = config.sourceSets[endPoint.sourceSet]

  app.get(endPointKey, (req, res, next) => {
    let file = target   
    for(const key of Object.keys(req.params)) {
      file = file.replace(`{${key}}`, req.params[key])      
    }
    storage.createReadStream(file)
    .then(async (imageStream) => {
      if(req.params.format == 'gif') {
        
        let srcSize = null
        try {
          const sizeStream = await storage.createReadStream(file)
          srcSize = await getStreamImageSize(sizeStream)  
        }
        catch (err) {
          // need to work without size
        }

        const transform = {  }

        endPoint.operations.forEach((operation) => {
          // gif operations are handled a bit differntly
          // no rotation (exif), since i dont think it's a problem
          // no crop, this is handled when width and height is specified
          
          switch(operation.type) {
            case 'resize':
              // ignore opreation crop, since it is used, when width and height are set
              const [targetWidth, targetHeight] = operation.size
              if(targetWidth && targetHeight) {
                if(srcSize) {
                  const targetRatio = targetWidth / targetHeight
                  const srcRatio = srcSize.width / srcSize.height

                  let cropX, cropY, cropWidth, cropHeight, scale

                  if(srcRatio > targetRatio) {
                    cropWidth = srcSize.height * targetRatio
                    cropHeight = srcSize.height
                    cropX = (srcSize.width - cropWidth) / 2
                    cropY = 0
                    scale = targetWidth/cropWidth
                  }
                  else {
                    cropWidth = srcSize.width
                    cropHeight = srcSize.width / targetRatio
                    cropX = 0
                    cropY = (srcSize.height - cropHeight) / 2
                    scale = targetHeight/cropHeight
                  }
                  
                  transform.crop = [cropX,cropY,cropWidth,cropHeight].map(Math.floor)
                  transform.scale = scale
                }
                else {
                  // fallback, just use whatever fits best
                  transform.width = targetWidth
                  transform.height = targetHeight
                }
              }
              else {
                if(targetWidth) {
                  if(srcSize && !operation.withoutEnlargement && targetWidth > srcSize.width) {
                    // upscale
                    transform.scale = (targetWidth/srcSize.width)
                  }
                  else {
                    transform.width = targetWidth
                  }
                }
                if(targetHeight) {
                  if(srcSize && !operation.withoutEnlargement && targetHeight > srcSize.height) {
                    transform.scale = (targetHeight/srcSize.height)
                  }
                  else {
                    transform.height = targetHeight
                  }
                }
              }
              break
            case 'paramcrop':
              transform.crop = [Number(req.params.left), Number(req.params.top), Number(req.params.width), Number(req.params.height)].map(Math.floor)
              break
          }
        })

        const gif = gifResize(transform)(imageStream)

        res.set('Content-Type', 'image/gif')
        
        gif.stdout.pipe(res)
        gif.stderr.resume()

        gif.then(() => res.end()).catch(() => res.end())
      }
      else {
        let op = sharp()
        let size = null
        let needResize = false
        let needResizeWithoutEnlargement = false
        endPoint.operations.forEach((operation) => {

          switch(operation.type) {
            case 'rotate':
              op = op.rotate()
              break
            case 'resize':
              size = operation.size
              needResize = true
              if(operation.withoutEnlargement) {
                needResizeWithoutEnlargement = true
              }
              break
            case 'crop':
              needResize = false
              switch(operation.strategy) {
                case 'attention':
                  op.resize(size[0], size[1], { fit: 'cover', position: 'attention' })
                  break
                default:
                  op.resize(size[0], size[1], { fit: 'cover', position: 'center' })
              }
              break
            case 'paramcrop':
              op.extract({
                left: Number(req.params.left),
                top: Number(req.params.top),
                width: Number(req.params.width),
                height: Number(req.params.height)
              })
              break
            default:
              throw new Error('Unsupportet operation: ' + operation.type)
          }

          if(needResize) {
            if(needResizeWithoutEnlargement) {
              op.resize(size[0], size[1], { fit: 'inside', withoutEnlargement: true })
            }
            else {
              op.resize(size[0], size[1])
            }
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
      console.log(error.message)
      next(new Error('File not found'))
      return
    })
  })
})

app.use((err, req, res, next) => {
  console.log("error", err)
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
