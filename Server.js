const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIo = require('socket.io');

const {
  getProjectById,
  updateProject,
  moveCell,
  resizeCell,
  addCells,
  removeCells,
  connectCells,
  changeCellProperties,
  changeEdgeStyle,
  changeEdgeLabel,
} = require('./Services/ModelService');


const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

let guestCounter = 1;
const connectedUsers = {};
const guests = {};
const workspaces = {}; // Estructura para almacenar usuarios por workspace

app.use(cors());
app.use(express.json());

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Registrar usuarios como invitados
  socket.on('signUpAsGuest', () => {
    const guestId = guestCounter++;
    guests[socket.id] = guestId;
    socket.emit('guestIdAssigned', { guestId });
    console.log(`Guest signed up: ${guestId} (Socket ID: ${socket.id})`); // Log cuando se registra un nuevo invitado
  });

  // Registro de usuarios
  const { saveOrUpdateUser } = require('./Services/UserService');

  socket.on('registerUser', async (userData) => {
      connectedUsers[userData.email] = socket.id;
      console.log(`${userData.email} registrado con socket ID ${socket.id}`);
  
      try {
          await saveOrUpdateUser(userData, socket.id);
          console.log(`User ${userData.email} has been saved/updated in the database`);
      } catch (err) {
          console.error('Error saving user data in the database:', err);
      }
  });
  
  // Registro de workspaces
  const { checkWorkspaceUser, addWorkspaceUser } = require('./Services/WorkspaceService.js');

socket.on('registerWorkspace', async (data) => {
    const { clientId, workspaceId } = data;

    if (!workspaceId || !clientId) {
        console.error('Workspace o ClientID undefined. No se puede registrar el workspace.');
        return;
    }

    try {
        const exists = await checkWorkspaceUser(workspaceId, clientId);

        if (!exists) {
            await addWorkspaceUser(workspaceId, clientId, socket.id);
            console.log(`Client ${clientId} registered to workspace ${workspaceId} (Socket ID: ${socket.id})`);
        } else {
            console.log(`Client ${clientId} already in workspace ${workspaceId}`);
        }

        io.to(socket.id).emit('workspaceRegistered', { success: true, workspaceId });
    } catch (err) {
        console.error('Error registrando el workspace en la base de datos:', err);
        io.to(socket.id).emit('workspaceRegistered', { success: false, error: err });
    }
});

  
// Gestionar invitaciones para colaborar
socket.on('sendInvitation', (data) => {
  const invitedSocketId = connectedUsers[data.invitedUserEmail];
  if (invitedSocketId) {
    io.to(invitedSocketId).emit('invitationReceived', data);
    console.log(`${data.inviterName} ha invitado a ${data.invitedUserEmail} a colaborar en el workspace ${data.workspaceId}`);
    
    // Hacer que el anfitrión también se una al workspace
    socket.join(data.workspaceId); // El socket del anfitrión se une al workspace
    console.log(`Host joined workspace ${data.workspaceId} (Socket ID: ${socket.id})`);
  } else {
    console.log(`User ${data.invitedUserEmail} not found or not connected.`);
  }
});

 // Unirse a un workspace
 const {getProjectByWorkspace } = require('./Services/WorkspaceService.js');

 socket.on('joinWorkspace', async (data) => {
    const { clientId, workspaceId } = data;

    socket.join(workspaceId);
    console.log(`Client ${clientId} joined workspace ${workspaceId} (Socket ID: ${socket.id})`);

    try {
        const exists = await checkWorkspaceUser(workspaceId, clientId);

        if (!exists) {
            await addWorkspaceUser(workspaceId, clientId, socket.id);
            console.log(`Client ${clientId} added to workspace ${workspaceId} in the database`);
        } else {
            console.log(`Client ${clientId} already in workspace ${workspaceId}`);
        }
    } catch (err) {
        console.error('Error saving workspace join in the database:', err);
        return;
    }

    // Si el proyecto ya existe en memoria, usarlo
    if (workspaces[workspaceId]) {
        console.log(`Sending existing project for workspace ${workspaceId} to client ${clientId}`);
        io.to(socket.id).emit('replaceProject', {
            clientId,
            workspaceId,
            project: workspaces[workspaceId],
        });
    } else {
        // Si no existe, intenta cargarlo desde la base de datos
        try {
            const project = await getProjectByWorkspace(workspaceId);

            if (!project) {
                console.log(`No project found for workspace ${workspaceId}`);
            } else {
                console.log(`Project found for workspace ${workspaceId}:`, project);
                workspaces[workspaceId] = project.project; // Guardar en memoria
                io.to(socket.id).emit('replaceProject', {
                    clientId,
                    workspaceId,
                    project: project.project,
                });
            }
        } catch (err) {
            console.error('Error retrieving project for workspace:', err);
        }
    }

    io.to(socket.id).emit('workspaceJoined', { clientId, workspaceId });
});

socket.on('openProject', async (data) => {
    const { workspaceId, projectId } = data;
    console.log(`Opening project ${projectId} for workspace ${workspaceId}`);

    try {
        // Obtener el proyecto desde la base de datos
        const project = await getProjectById(projectId);

        if (!project) {
            console.error(`Project ${projectId} not found`);
            io.to(socket.id).emit('error', { message: 'Project not found' });
            return;
        }

        // Guardar el proyecto en memoria asociado al workspaceId
        workspaces[workspaceId] = project;

        // Emitir el nuevo proyecto a todos los usuarios en el workspace
        io.to(workspaceId).emit('projectOpened', { project });

        console.log(`Project ${projectId} sent to workspace ${workspaceId}`);
    } catch (err) {
        console.error('Error opening project:', err);
        io.to(socket.id).emit('error', { message: 'Failed to open project' });
    }
});


const { checkWorkspaceExists, deleteExistingProject, insertProject } = require('./Services/ProjectService');

socket.on('projectCreated', async (data) => {
    console.log('Server received projectCreated:', data);

    try {
        const workspaceExists = await checkWorkspaceExists(data.workspaceId, data.clientId);

        if (!workspaceExists) {
            console.error(`Workspace ${data.workspaceId} no existe en workspace_users. No se puede crear el proyecto.`);
            setTimeout(async () => {
                const retryWorkspaceExists = await checkWorkspaceExists(data.workspaceId, data.clientId);
                if (!retryWorkspaceExists) {
                    console.error(`Workspace ${data.workspaceId} no existe tras reintento. No se puede crear el proyecto.`);
                    return;
                }
                await deleteExistingProject(data.workspaceId);
                await insertProject(data.project.id, data.project, data.workspaceId);
            }, 1000);
            return;
        }

        await deleteExistingProject(data.workspaceId);
        await insertProject(data.project.id, data.project, data.workspaceId);
        socket.to(data.workspaceId).emit('projectCreated', data);

    } catch (err) {
        console.error('Error guardando el proyecto en la base de datos:', err);
    }
});

// Manejar la creación de productLines
const { getProjectById, updateProject } = require('./Services/ProjectService');

socket.on('productLineCreated', async (data) => {
    console.log('Server received productLineCreated:', data);

    try {
        const projectJson = await getProjectById(data.projectId);

        if (!projectJson) {
            console.error('Error: Proyecto no encontrado para actualizar la ProductLine.');
            return;
        }

        const newProductLine = {
            id: data.productLine.id,
            name: data.productLine.name,
            type: data.productLine.type,
            domain: data.productLine.domain,
            domainEngineering: {
                models: [],
                relationships: [],
                constraints: "",
            },
        };

        projectJson.productLines.push(newProductLine);

        await updateProject(data.projectId, projectJson);
        console.log(`ProductLine guardada en el proyecto: ${data.productLine.name}`);

        socket.to(data.workspaceId).emit('productLineCreated', data);
    } catch (err) {
        console.error('Error guardando la ProductLine en la base de datos:', err);
    }
});

// Manejar la creación de un nuevo modelo
socket.on('modelCreated', async (data) => {
  console.log('Server received modelCreated:', data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para agregar el modelo.');
          return;
      }

      const newModel = {
          id: data.model.id,
          name: data.model.name,
          type: data.model.type,
          elements: [],
          relationships: [],
          constraints: "",
      };

      const productLine = projectJson.productLines.find(pl => pl.id === data.productLineId);
      if (!productLine) {
          console.error('ProductLine no encontrada para agregar el modelo');
          return;
      }

      productLine.domainEngineering.models.push(newModel);

      await updateProject(data.projectId, projectJson);
      console.log(`Modelo guardado en el proyecto: ${data.model.name}`);

      socket.to(data.workspaceId).emit('modelCreated', data);
  } catch (err) {
      console.error('Error guardando el modelo en el proyecto:', err);
  }
});

// Manejar la eliminación de un modelo
socket.on('modelDeleted', async (data) => {
  console.log(`Server received modelDeleted:`, data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para eliminar el modelo.');
          return;
      }

      const productLine = projectJson.productLines.find(pl => pl.id === data.productLineId);
      if (!productLine) {
          console.error('ProductLine no encontrada para eliminar el modelo.');
          return;
      }

      productLine.domainEngineering.models = productLine.domainEngineering.models.filter(
          (model) => model.id !== data.modelId
      );

      await updateProject(data.projectId, projectJson);
      console.log(`Modelo eliminado del proyecto: ${data.modelId}`);

      socket.to(data.workspaceId).emit('modelDeleted', data);
  } catch (err) {
      console.error('Error eliminando el modelo en el proyecto:', err);
  }
});

// Manejar el renombramiento de un modelo
socket.on('modelRenamed', async (data) => {
  console.log(`Server received modelRenamed:`, data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para renombrar el modelo.');
          return;
      }

      const productLine = projectJson.productLines.find(pl => pl.id === data.productLineId);
      if (!productLine) {
          console.error('ProductLine no encontrada para renombrar el modelo.');
          return;
      }

      const model = productLine.domainEngineering.models.find((model) => model.id === data.modelId);
      if (!model) {
          console.error('Modelo no encontrado para renombrar.');
          return;
      }

      model.name = data.newName;

      await updateProject(data.projectId, projectJson);
      console.log(`Nombre del modelo actualizado en el proyecto: ${data.modelId}`);

      socket.to(data.workspaceId).emit('modelRenamed', data);
  } catch (err) {
      console.error('Error renombrando el modelo en el proyecto:', err);
  }
});

// Manejar la configuración de un modelo
socket.on('modelConfigured', async (data) => {
  console.log(`Server received modelConfigured:`, data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para configurar el modelo.');
          return;
      }

      const productLine = projectJson.productLines.find(pl => pl.id === data.productLineId);
      if (!productLine) {
          console.error('ProductLine no encontrada para configurar el modelo.');
          return;
      }

      const model = productLine.domainEngineering.models.find((model) => model.id === data.modelId);
      if (!model) {
          console.error('Modelo no encontrado para configurar.');
          return;
      }

      model.configuration = data.configuration;

      await updateProject(data.projectId, projectJson);
      console.log(`Configuración del modelo actualizada en el proyecto: ${data.modelId}`);

      socket.to(data.workspaceId).emit('modelConfigured', data);
  } catch (err) {
      console.error('Error configurando el modelo en el proyecto:', err);
  }
});
  
socket.on('cellMoved', async (data) => {
  console.log('Server received cellMoved:', data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para mover la celda.');
          return;
      }

      await moveCell(projectJson, data.projectId, data.cellId, data.cell);
      console.log(`Celda movida en el proyecto: ${data.cellId}`);
      socket.to(data.workspaceId).emit('cellMoved', data);
  } catch (err) {
      console.error('Error moviendo la celda en el proyecto:', err);
  }
});

socket.on('cellResized', async (data) => {
  console.log('Server received cellResized:', data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para redimensionar la celda.');
          return;
      }

      await resizeCell(projectJson, data.projectId, data.cellId, data.cell);
      console.log(`Celda redimensionada en el proyecto: ${data.cellId}`);
      socket.to(data.workspaceId).emit('cellResized', data);
  } catch (err) {
      console.error('Error redimensionando la celda en el proyecto:', err);
  }
});

socket.on('cellAdded', async (data) => {
  console.log('Server received cellAdded:', data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para agregar celdas.');
          return;
      }

      const newCells = data.cells.map(cell => ({
          id: cell.id,
          type: cell.type,
          x: cell.x,
          y: cell.y,
          width: cell.width,
          height: cell.height,
          label: cell.label || '',
          style: cell.style || '',
          properties: cell.properties || [],
      }));

      await addCells(projectJson, data.projectId, data.modelId, newCells);
      console.log(`Celdas añadidas al modelo: ${data.modelId}`);
      socket.to(data.workspaceId).emit('cellAdded', data);
  } catch (err) {
      console.error('Error añadiendo celdas en el proyecto:', err);
  }
});

socket.on('cellRemoved', async (data) => {
  console.log('Server received cellRemoved:', data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para eliminar celdas.');
          return;
      }

      await removeCells(projectJson, data.projectId, data.cellIds);
      console.log(`Celdas eliminadas del modelo: ${data.cellIds.join(', ')}`);
      socket.to(data.workspaceId).emit('cellRemoved', data);
  } catch (err) {
      console.error('Error eliminando celdas en el proyecto:', err);
  }
});

socket.on('cellConnected', async (data) => {
  console.log('Server received cellConnected:', data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para conectar celdas.');
          return;
      }

      const connection = {
          sourceId: data.sourceId,
          targetId: data.targetId,
          properties: data.properties || [],
      };

      await connectCells(projectJson, data.projectId, data.modelId, connection);
      console.log(`Celdas conectadas: ${data.sourceId} -> ${data.targetId}`);
      socket.to(data.workspaceId).emit('cellConnected', data);
  } catch (err) {
      console.error('Error conectando celdas en el proyecto:', err);
  }
});

socket.on('propertiesChanged', async (data) => {
  console.log('Server received propertiesChanged:', data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para cambiar propiedades.');
          return;
      }

      await changeCellProperties(projectJson, data.projectId, data.cellId, data.properties);
      console.log(`Propiedades actualizadas para la celda: ${data.cellId}`);
      socket.to(data.workspaceId).emit('propertiesChanged', data);
  } catch (err) {
      console.error('Error cambiando propiedades de la celda en el proyecto:', err);
  }
});

socket.on('edgeStyleChanged', async (data) => {
  console.log('Server received edgeStyleChanged:', data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para cambiar estilo del borde.');
          return;
      }

      await changeEdgeStyle(projectJson, data.projectId, data.edgeId, data.newStyle);
      console.log(`Estilo del borde actualizado: ${data.edgeId}`);
      socket.to(data.workspaceId).emit('edgeStyleChanged', data);
  } catch (err) {
      console.error('Error cambiando estilo del borde en el proyecto:', err);
  }
});

socket.on('edgeLabelChanged', async (data) => {
  console.log('Server received edgeLabelChanged:', data);

  try {
      const projectJson = await getProjectById(data.projectId);

      if (!projectJson) {
          console.error('Error: Proyecto no encontrado para cambiar etiqueta del borde.');
          return;
      }

      await changeEdgeLabel(projectJson, data.projectId, data.edgeId, data.label);
      console.log(`Etiqueta del borde actualizada: ${data.edgeId}`);
      socket.to(data.workspaceId).emit('edgeLabelChanged', data);
  } catch (err) {
      console.error('Error cambiando etiqueta del borde en el proyecto:', err);
  }
});

socket.on('cursorMoved', (data) => {
    io.to(data.workspaceId).emit('cursorMoved', data);
});
  
  // Al desconectarse, eliminar el usuario del workspace correspondiente
  socket.on('disconnect', () => {
    // Eliminar el usuario del mapa de usuarios conectados cuando se desconecta
    for (const email in connectedUsers) {
      if (connectedUsers[email] === socket.id) {
        delete connectedUsers[email];
        break;
      }
    }
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = 4000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});