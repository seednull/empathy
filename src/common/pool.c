#include "pool.h"
#include "intrinsics.h"

#include <stdlib.h>
#include <string.h>
#include <assert.h>

/*
 */
static EMPATHY_INLINE Empathy_PoolHandle empathy_poolHandlePack(uint32_t index, uint8_t generation)
{
	return (Empathy_PoolHandle)((index << 8) | generation);
}

static EMPATHY_INLINE uint32_t empathy_poolHandleGetIndex(Empathy_PoolHandle handle)
{
	return (uint32_t)(handle >> 8);
}

static EMPATHY_INLINE uint8_t empathy_poolHandleGetGeneration(Empathy_PoolHandle handle)
{
	return (uint8_t)(handle & 0xFF);
}

/*
 */
static EMPATHY_INLINE uint32_t empathy_poolGrabIndex(Empathy_Pool *pool)
{
	assert(pool);
	assert(pool->num_free_indices > 0);

	uint32_t index = pool->indices[pool->num_free_indices - 1];
	pool->num_free_indices--;

	uint32_t mask_index = index / 32;
	uint32_t mask_bit = index % 32;

	pool->masks[mask_index] &= ~(1 << mask_bit);

	return index;
}

static EMPATHY_INLINE void empathy_poolReleaseIndex(Empathy_Pool *pool, uint32_t index)
{
	assert(pool);
	assert(pool->num_free_indices < pool->capacity);
	assert(index < pool->capacity);

	pool->num_free_indices++;
	pool->indices[pool->num_free_indices - 1] = index;

	uint32_t mask_index = index / 32;
	uint32_t mask_bit = index % 32;

	pool->masks[mask_index] |= 1 << mask_bit;
}

static EMPATHY_INLINE uint32_t empathy_poolIsIndexFree(const Empathy_Pool *pool, uint32_t index)
{
	assert(pool);
	assert(index < pool->capacity);

	uint32_t mask_index = index / 32;
	uint32_t mask_bit = index % 32;

	uint32_t free_mask = pool->masks[mask_index];
	uint32_t element_mask = 1 << mask_bit;

	return free_mask & element_mask;
}

static EMPATHY_INLINE uint32_t empathy_poolGetNumMasks(const Empathy_Pool *pool)
{
	assert(pool);

	return alignUp(pool->capacity, 32) / 32;
}

/*
 */
Empathy_Result empathy_poolInitialize(Empathy_Pool *pool, uint32_t element_size, uint32_t capacity)
{
	assert(pool);
	assert(element_size > 0);

	memset(pool, 0, sizeof(Empathy_Pool));

	pool->element_size = element_size;
	pool->capacity = capacity;
	pool->num_free_indices = capacity;
	pool->head = EMPATHY_POOL_HANDLE_NULL;
	pool->tail = EMPATHY_POOL_HANDLE_NULL;

	if (capacity > 0)
	{
		uint32_t num_masks = empathy_poolGetNumMasks(pool);

		pool->data = (uint8_t *)malloc(element_size * capacity);
		pool->generations = (uint8_t *)malloc(sizeof(uint8_t) * capacity);
		pool->nexts = (uint32_t *)malloc(sizeof(uint32_t) * capacity);
		pool->prevs = (uint32_t *)malloc(sizeof(uint32_t) * capacity);
		pool->indices = (uint32_t *)malloc(sizeof(uint32_t) * capacity);
		pool->masks = (uint32_t *)malloc(sizeof(uint32_t) * num_masks);

		for (uint32_t i = 0; i < capacity; ++i)
			pool->indices[i] = capacity - i - 1;

		memset(pool->nexts, EMPATHY_POOL_HANDLE_NULL, sizeof(uint32_t) * capacity);
		memset(pool->prevs, EMPATHY_POOL_HANDLE_NULL, sizeof(uint32_t) * capacity);
		memset(pool->masks, 0xFFFFFFFF, sizeof(uint32_t) * num_masks);
		memset(pool->generations, 0, sizeof(uint8_t) * capacity);
	}

	return EMPATHY_SUCCESS;
}

Empathy_Result empathy_poolShutdown(Empathy_Pool *pool)
{
	assert(pool);

	free(pool->data);
	free(pool->generations);
	free(pool->nexts);
	free(pool->prevs);
	free(pool->indices);
	free(pool->masks);

	memset(pool, 0, sizeof(Empathy_Pool));

	return EMPATHY_SUCCESS;
}

/*
 */
Empathy_PoolHandle empathy_poolAddElement(Empathy_Pool *pool, const void *data)
{
	assert(pool);
	assert(data);

	if (pool->size == pool->capacity)
	{
		uint32_t old_capacity = pool->capacity;
		uint32_t old_num_masks = empathy_poolGetNumMasks(pool);

		pool->capacity = (pool->capacity == 0) ? 1 : pool->capacity * 2;
		uint32_t new_num_masks = empathy_poolGetNumMasks(pool);

		pool->data = (uint8_t *)realloc(pool->data, pool->element_size * pool->capacity);
		pool->generations = (uint8_t *)realloc(pool->generations, sizeof(uint8_t) * pool->capacity);
		pool->nexts = (uint32_t *)realloc(pool->nexts, sizeof(uint32_t) * pool->capacity);
		pool->prevs = (uint32_t *)realloc(pool->prevs, sizeof(uint32_t) * pool->capacity);
		pool->indices = (uint32_t *)realloc(pool->indices, sizeof(uint32_t) * pool->capacity);

		if (old_num_masks != new_num_masks)
			pool->masks = (uint32_t *)realloc(pool->masks, sizeof(uint32_t) * new_num_masks);

		for (uint32_t i = old_capacity; i < pool->capacity; ++i)
		{
			pool->num_free_indices++;
			pool->indices[pool->num_free_indices - 1] = old_capacity + pool->capacity - i - 1;
			pool->generations[i] = 0;
			pool->nexts[i] = EMPATHY_POOL_HANDLE_NULL;
			pool->prevs[i] = EMPATHY_POOL_HANDLE_NULL;
		}

		for (uint32_t i = old_num_masks; i < new_num_masks; ++i)
			pool->masks[i] = 0xFFFFFFFF;
	}

	assert(pool->num_free_indices > 0);

	uint32_t index = empathy_poolGrabIndex(pool);

	uint8_t *data_ptr = pool->data + index * pool->element_size;
	uint8_t *generation_ptr = pool->generations + index;

	if (pool->head == EMPATHY_POOL_HANDLE_NULL)
		pool->head = index;

	if (pool->tail == EMPATHY_POOL_HANDLE_NULL)
	{
		pool->tail = index;
	}
	else
	{
		pool->nexts[pool->tail] = index;
		pool->prevs[index] = pool->tail;

		pool->tail = index;
	}

	memcpy(data_ptr, data, pool->element_size);

	uint8_t generation = *generation_ptr + 1;
	*generation_ptr = max(1, generation);

	pool->size++;

	return empathy_poolHandlePack(index, *generation_ptr);
}

Empathy_Result empathy_poolRemoveElement(Empathy_Pool *pool, Empathy_PoolHandle handle)
{
	assert(pool);

	if (handle == EMPATHY_POOL_HANDLE_NULL)
		return EMPATHY_INTERNAL_ERROR;

	if (pool->size == 0)
		return EMPATHY_INTERNAL_ERROR;

	uint32_t index = empathy_poolHandleGetIndex(handle);
	uint8_t generation = empathy_poolHandleGetGeneration(handle);

	if (pool->generations[index] != generation)
		return EMPATHY_INTERNAL_ERROR;

	if (empathy_poolIsIndexFree(pool, index))
		return EMPATHY_INTERNAL_ERROR;

	uint32_t prev = pool->prevs[index];
	uint32_t next = pool->nexts[index];

	pool->prevs[index] = EMPATHY_POOL_HANDLE_NULL;
	pool->nexts[index] = EMPATHY_POOL_HANDLE_NULL;

	if (next != EMPATHY_POOL_HANDLE_NULL)
		pool->prevs[next] = prev;

	if (prev != EMPATHY_POOL_HANDLE_NULL)
		pool->nexts[prev] = next;

	if (pool->head == index)
		pool->head = next;

	if (pool->tail == index)
		pool->tail = prev;

	empathy_poolReleaseIndex(pool, index);
	pool->size--;

	return EMPATHY_SUCCESS;
}

void *empathy_poolGetElement(const Empathy_Pool *pool, Empathy_PoolHandle handle)
{
	assert(pool);
	assert(pool->size > 0);

	if (handle == EMPATHY_POOL_HANDLE_NULL)
		return NULL;

	uint32_t index = empathy_poolHandleGetIndex(handle);
	uint8_t generation = empathy_poolHandleGetGeneration(handle);

	if (pool->generations[index] != generation)
		return NULL;

	if (empathy_poolIsIndexFree(pool, index))
		return NULL;

	return pool->data + index * pool->element_size;
}

void *empathy_poolGetElementByIndex(const Empathy_Pool *pool, uint32_t index)
{
	assert(pool);
	assert(pool->size > 0);
	assert(pool->capacity > index);
	assert(index != EMPATHY_POOL_HANDLE_NULL);

	return pool->data + index * pool->element_size;
}

uint32_t empathy_poolGetHeadIndex(const Empathy_Pool *pool)
{
	assert(pool);
	return pool->head;
}

uint32_t empathy_poolGetTailIndex(const Empathy_Pool *pool)
{
	assert(pool);
	return pool->tail;
}

uint32_t empathy_poolGetNextIndex(const Empathy_Pool *pool, uint32_t index)
{
	assert(pool);
	assert(pool->size > 0);
	assert(pool->capacity > index);
	assert(index != EMPATHY_POOL_HANDLE_NULL);
	
	return pool->nexts[index];
}

uint32_t empathy_poolGetPrevIndex(const Empathy_Pool *pool, uint32_t index)
{
	assert(pool);
	assert(pool->size > 0);
	assert(pool->capacity > index);
	assert(index != EMPATHY_POOL_HANDLE_NULL);
	
	return pool->prevs[index];
}
